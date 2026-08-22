import { Order, canTransition } from '../models/Order';
import { Subscription } from '../models/Subscription';
import { Customer } from '../models/Customer';
import { getSettings } from '../models/Setting';
import { nextOrderReference } from '../models/Counter';
import { logEvent } from '../models/Event';
import {
  isShiprocketConfigured,
  createShiprocketOrder,
  assignAwb,
  requestPickup,
  trackAwb,
  TRACK_TO_STATUS,
} from './shiprocket';
import { isCashfreeConfigured, getCashfreeOrder } from './cashfree';
import {
  applyStatusChange,
  markOrderConfirmedPaid,
  markOrderPaymentFailed,
  markPendingCheckoutFailed,
  materializePendingCheckout,
  stampTimeline,
} from './orderLifecycle';
import { PendingCheckout } from '../models/PendingCheckout';
import { getAutopayCharge, raiseAutopayCharge } from './cashfreeSubscriptions';
import { runAutopayReminderSweep } from './autopayReminders';
import { ReturnRequest } from '../models/ReturnRequest';
import { approveReturn, receiveReturn, refundReturn } from './returnLifecycle';
import { env } from '../config/env';
import type { OrderStatus } from '../models/Order';

// Hands-off syncing engine. All commerce integrations are backend-owned and
// run on the environment-configured interval.

const PER_STEP_LIMIT = 6;
let running = false;

export async function runSync(force = false): Promise<{ ran: boolean; actions: string[] }> {
  if (running) return { ran: false, actions: [] };
  const settings = await getSettings();
  const auto = settings.automation;

  if (!force && auto.lastRunAt && Date.now() - auto.lastRunAt.getTime() < 55_000) {
    return { ran: false, actions: [] };
  }

  running = true;
  const actions: string[] = [];
  try {
    /* ---------------------------------------------- auto-book shipments */
    // The ONE step behind a switch: booking a courier costs money, so the
    // team decides whether a paid order books itself or waits for "Create
    // shipment" on the order page. Tracking, payments and subscription cycles
    // below are always on — nothing in the panel should need a sync button.
    if (auto.autoShipments && (await isShiprocketConfigured())) {
      const candidates = await Order.find({
        status: { $in: ['confirmed', 'packed'] },
        'shipment.shipmentId': '',
        'shipment.holdAutoBook': { $ne: true },
        // Prepaid orders must be settled. Confirmed COD orders are collected
        // by the courier, so they must also reach Shiprocket.
        $or: [
          { paymentStatus: 'paid' },
          { paymentMethod: 'cod', paymentStatus: 'pending' },
        ],
      }).limit(PER_STEP_LIMIT);
      for (const order of candidates) {
        // Claim the order BEFORE calling Shiprocket, so a save that fails
        // afterwards (or a second worker) can never book the same parcel
        // twice. A failed booking releases the claim.
        const claim = await Order.updateOne(
          { _id: order._id, 'shipment.shipmentId': '' },
          { $set: { 'shipment.shipmentId': 'booking', 'shipment.provider': 'shiprocket' } },
        );
        if (claim.modifiedCount === 0) continue;
        try {
          const created = await createShiprocketOrder(order);
          order.shipment.provider = 'shiprocket';
          order.shipment.orderId = String(created.order_id);
          order.shipment.shipmentId = String(created.shipment_id);
          order.shipment.createdAt = new Date();
          const awb = await assignAwb(String(created.shipment_id)).catch(() => null);
          const data = awb?.response?.data;
          if (data?.awb_code) {
            order.shipment.awb = data.awb_code;
            order.shipment.courier = data.courier_name ?? '';
            order.trackingNumber = data.awb_code;
            order.courier = data.courier_name ?? '';
            // The courier is assigned — ask them to come and collect it too.
            try {
              await requestPickup(String(created.shipment_id));
              order.shipment.pickupRequestedAt = new Date();
            } catch {
              /* retried below on the next sweep */
            }
          }
          order.notes.push({ by: 'Sync', text: 'Shipment booked automatically.', at: new Date() });
          if (order.status === 'confirmed') {
            order.status = 'packed';
            stampTimeline(order, 'packed');
          }
          await order.save();
          actions.push(`Booked shipment for ${order.reference}`);
        } catch (err) {
          await Order.updateOne(
            { _id: order._id, 'shipment.shipmentId': 'booking' },
            { $set: { 'shipment.shipmentId': '', 'shipment.provider': '' } },
          );
          actions.push(`${order.reference}: shipment failed — ${err instanceof Error ? err.message : 'error'}`);
        }
      }

      // Bookings that got a courier but no pickup slot (Shiprocket hiccup):
      // keep asking until the pickup is scheduled, so nothing sits in the
      // warehouse waiting for a click.
      const noPickup = await Order.find({
        'shipment.provider': 'shiprocket',
        'shipment.awb': { $ne: '' },
        'shipment.pickupRequestedAt': null,
        status: { $in: ['packed'] },
      }).limit(PER_STEP_LIMIT);
      for (const order of noPickup) {
        try {
          await requestPickup(order.shipment.shipmentId);
          order.shipment.pickupRequestedAt = new Date();
          await order.save();
          actions.push(`${order.reference}: pickup scheduled`);
        } catch {
          /* next sweep */
        }
      }
    }

    /* ------------------------------------------------- tracking -> status */
    if (await isShiprocketConfigured()) {
      // Least-recently-checked first, and every check is stamped — so with
      // more parcels in flight than one sweep covers, each still gets its
      // turn and the order page shows when it was last looked at.
      const tracked = await Order.find({
        'shipment.provider': 'shiprocket',
        'shipment.awb': { $ne: '' },
        status: { $in: ['packed', 'shipped', 'out_for_delivery'] },
      })
        .sort({ 'shipment.lastSyncedAt': 1 })
        .limit(PER_STEP_LIMIT);
      for (const order of tracked) {
        try {
          const info = await trackAwb(order.shipment.awb);
          const current = info.tracking_data?.shipment_track?.[0]?.current_status?.toUpperCase() ?? '';
          order.shipment.lastSyncedAt = new Date();
          if (current) order.shipment.status = current;
          const mapped = TRACK_TO_STATUS[current] as OrderStatus | undefined;
          if (mapped && mapped !== order.status && canTransition(order.status, mapped)) {
            order.notes.push({ by: 'Sync', text: `Courier update: ${current}.`, at: new Date() });
            await applyStatusChange(order, mapped);
            actions.push(`${order.reference} → ${mapped}`);
          } else {
            await order.save();
          }
        } catch {
          /* transient tracking errors are fine */
        }
      }
    }

    /* --------------------------------------------- awaiting-payment sweep */
    // Checkouts still waiting on the gateway. A payment that cleared while
    // nobody was watching — the customer closed the tab, the webhook never
    // arrived — becomes a real order here. One that failed is closed out, and
    // no order is ever created for it.
    if (await isCashfreeConfigured()) {
      const waiting = await PendingCheckout.find({
        status: 'awaiting_payment',
        orderId: null,
        'cashfree.orderId': { $ne: '' },
      }).limit(PER_STEP_LIMIT);

      for (const checkout of waiting) {
        try {
          const cf = await getCashfreeOrder(checkout.cashfree.orderId);
          if (cf.order_status === 'PAID') {
            const order = await materializePendingCheckout(checkout);
            if (order) actions.push(`${order.reference} paid — order created`);
          } else if (cf.order_status === 'EXPIRED' || cf.order_status === 'TERMINATED') {
            await markPendingCheckoutFailed(checkout);
            actions.push(`${checkout.reference} checkout ${cf.order_status.toLowerCase()} — no order created`);
          }
        } catch {
          /* leave it waiting */
        }
      }
    }

    /* ---------------------------------------------- pending payments sync */
    if (await isCashfreeConfigured()) {
      const pending = await Order.find({
        paymentMethod: 'online',
        paymentStatus: 'pending',
        'cashfree.orderId': { $ne: '' },
      }).limit(PER_STEP_LIMIT);
      for (const order of pending) {
        try {
          const cf = await getCashfreeOrder(order.cashfree.orderId);
          if (cf.order_status === 'PAID') {
            await markOrderConfirmedPaid(order);
            actions.push(`${order.reference} payment settled`);
          } else if (cf.order_status === 'EXPIRED' || cf.order_status === 'TERMINATED') {
            await markOrderPaymentFailed(order);
            actions.push(`${order.reference} payment ${cf.order_status.toLowerCase()}`);
          }
        } catch {
          /* keep pending */
        }
      }
    }

    /* --------------------------------------- subscription cycle generation */
    {
      const due = await Subscription.find({
        status: 'active',
        nextDelivery: { $ne: null, $lte: new Date() },
      }).limit(PER_STEP_LIMIT);

      for (const sub of due) {
        try {
          // Auto-pay plans charge the mandate first; the order is created only
          // when the money clears (below, or in the webhook). One charge at a
          // time per plan.
          if (sub.autopay.status === 'active' && sub.autopay.subscriptionId) {
            if (sub.autopay.pendingChargeId) continue;
            const chargeId = `CYC-${sub.reference}-${sub.cyclesDelivered + 1}`;
            // RBI pre-debit notice: schedule ~26h out; Cashfree notifies the
            // customer itself before debiting.
            await raiseAutopayCharge({
              subscriptionId: sub.autopay.subscriptionId,
              paymentId: chargeId,
              amount: sub.price * sub.quantity,
              scheduleAt: new Date(Date.now() + 26 * 3600_000),
            });
            sub.autopay.pendingChargeId = chargeId;
            sub.autopay.pendingChargeAt = new Date();
            await sub.save();
            actions.push(`${sub.reference}: auto-pay charge ${chargeId} scheduled`);
            continue;
          }

          // No mandate: the cycle ships as pay-on-delivery, as before.
          const order = await createCycleOrder(sub, { paid: false });
          if (order) actions.push(`Cycle order ${order.reference} for ${sub.reference} (pay on delivery)`);
        } catch (err) {
          actions.push(`${sub.reference}: cycle failed — ${err instanceof Error ? err.message : 'error'}`);
        }
      }
    }

    /* ------------------------------------------- auto-pay charge follow-up */
    {
      const charging = await Subscription.find({
        'autopay.pendingChargeId': { $ne: '' },
      }).limit(PER_STEP_LIMIT);

      for (const sub of charging) {
        try {
          const charge = await getAutopayCharge(sub.autopay.subscriptionId, sub.autopay.pendingChargeId);
          const status = (charge.payment_status || '').toUpperCase();

          if (status === 'SUCCESS' || status === 'PAID') {
            const order = await createCycleOrder(sub, { paid: true, chargeId: sub.autopay.pendingChargeId });
            sub.autopay.lastChargeStatus = 'success';
            sub.autopay.pendingChargeId = '';
            sub.autopay.pendingChargeAt = null;
            await sub.save();
            if (order) actions.push(`${sub.reference}: auto-pay charge cleared — order ${order.reference}`);
          } else if (status === 'FAILED' || status === 'CANCELLED') {
            // The debit bounced. The box still ships — as pay-on-delivery —
            // and the team is told, so a failed mandate never silently stops
            // a subscription someone is expecting.
            sub.autopay.lastChargeStatus = 'failed';
            sub.autopay.pendingChargeId = '';
            sub.autopay.pendingChargeAt = null;
            await sub.save();
            const order = await createCycleOrder(sub, { paid: false });
            await logEvent('subscription', `${sub.reference} auto-debit failed`, 'Cycle shipped as pay-on-delivery', '/subscriptions');
            if (order) actions.push(`${sub.reference}: auto-debit FAILED — cycle ${order.reference} as pay-on-delivery`);
          }
          // Anything else (SCHEDULED / INITIATED / PENDING): keep waiting.
        } catch {
          /* re-checked next sweep */
        }
      }
    }

    /* ---------------------------------------------------------- returns */
    // The return journey without a human in it: approve (if switched on),
    // keep asking the courier for a pickup slot, follow the parcel back, and
    // the moment it is delivered to the warehouse restock and refund.
    {
      if (auto.autoApproveReturns) {
        const requested = await ReturnRequest.find({ status: 'requested' }).limit(PER_STEP_LIMIT);
        for (const ret of requested) {
          try {
            await approveReturn(ret, { by: 'Sync' });
            actions.push(`${ret.reference} approved automatically${ret.shiprocket.awb ? ` — ${ret.shiprocket.courier} ${ret.shiprocket.awb}` : ''}`);
          } catch (err) {
            actions.push(`${ret.reference}: auto-approve failed — ${err instanceof Error ? err.message : 'error'}`);
          }
        }
      }

      if (await isShiprocketConfigured()) {
        // Booked but no courier / no pickup slot yet — keep trying.
        const halfBooked = await ReturnRequest.find({
          status: 'approved',
          'shiprocket.shipmentId': { $ne: '' },
          $or: [{ 'shiprocket.awb': '' }, { 'shiprocket.pickupRequestedAt': null }],
        }).limit(PER_STEP_LIMIT);
        for (const ret of halfBooked) {
          try {
            if (!ret.shiprocket.awb) {
              const awb = await assignAwb(ret.shiprocket.shipmentId);
              if (awb.response?.data?.awb_code) {
                ret.shiprocket.awb = awb.response.data.awb_code;
                ret.shiprocket.courier = awb.response.data.courier_name ?? '';
              }
            }
            if (ret.shiprocket.awb && !ret.shiprocket.pickupRequestedAt) {
              await requestPickup(ret.shiprocket.shipmentId);
              ret.shiprocket.pickupRequestedAt = new Date();
            }
            await ret.save();
          } catch {
            /* next sweep */
          }
        }

        // Follow the parcel home. "DELIVERED" on a return means it reached the
        // warehouse — restock and refund without anyone clicking.
        const coming = await ReturnRequest.find({ status: 'approved', 'shiprocket.awb': { $ne: '' } })
          .sort({ 'shiprocket.lastSyncedAt': 1 })
          .limit(PER_STEP_LIMIT);
        for (const ret of coming) {
          try {
            const info = await trackAwb(ret.shiprocket.awb);
            const current = info.tracking_data?.shipment_track?.[0]?.current_status?.toUpperCase() ?? '';
            ret.shiprocket.lastSyncedAt = new Date();
            if (current) ret.shiprocket.status = current;
            await ret.save();
            if (current === 'DELIVERED') {
              await receiveReturn(ret, { by: 'Sync' });
              actions.push(`${ret.reference} back at warehouse — restocked`);
            }
          } catch (err) {
            actions.push(`${ret.reference}: return sync — ${err instanceof Error ? err.message : 'error'}`);
          }
        }
      }

      // Back at the warehouse → money back. Prepaid refunds go through
      // Cashfree on their own. A cash-on-delivery return has no card to
      // refund to: the team is told once to pay it out by bank transfer and
      // records it with the Refund button.
      const received = await ReturnRequest.find({ status: 'received' }).limit(PER_STEP_LIMIT);
      for (const ret of received) {
        try {
          if (ret.isPrepaid) {
            const { mode } = await refundReturn(ret, { by: 'Sync' });
            actions.push(`${ret.reference} refunded automatically (${mode === 'cashfree' ? 'Cashfree' : 'recorded — no gateway link on the order'})`);
          } else if (!ret.notes.some((n) => n.text.startsWith('Payout needed'))) {
            ret.notes.push({ by: 'Sync', text: `Payout needed: ₹${ret.amount.toLocaleString('en-IN')} by bank transfer, then press Refund.`, at: new Date() });
            await ret.save();
            await logEvent('payment', `${ret.reference}: pay ₹${ret.amount.toLocaleString('en-IN')} back to ${ret.customerName}`, 'Cash-on-delivery return — bank transfer, then press Refund', `/returns/${ret.id}`);
            actions.push(`${ret.reference} received — COD payout flagged for the team`);
          }
        } catch (err) {
          actions.push(`${ret.reference}: auto-refund failed — ${err instanceof Error ? err.message : 'error'}`);
        }
      }
    }

    /* ------------------------------------------- auto-pay set-up reminders */
    try {
      actions.push(...(await runAutopayReminderSweep(PER_STEP_LIMIT)));
    } catch (err) {
      actions.push(`auto-pay reminders: ${err instanceof Error ? err.message : 'error'}`);
    }

    /* ------------------------------------------------------------- record */
    settings.automation.lastRunAt = new Date();
    if (actions.length > 0) {
      settings.automation.log.unshift(
        ...actions.slice(0, 10).map((text) => ({ at: new Date(), text })),
      );
      if (settings.automation.log.length > 100) settings.automation.log.splice(100);
    }
    await settings.save();
    return { ran: true, actions };
  } finally {
    running = false;
  }
}

/** In-process worker — external cron via POST /internal/sync/run also works. */
export function startSyncWorker(): NodeJS.Timeout | null {
  if (env.syncIntervalSeconds <= 0) return null;
  const timer = setInterval(() => {
    runSync().catch((err) => console.error('[sync]', err));
  }, env.syncIntervalSeconds * 1000);
  timer.unref();
  console.log(`[sync] worker every ${env.syncIntervalSeconds}s`);
  return timer;
}

/**
 * One subscription cycle becomes one order.
 *
 * Idempotent on the charge id: the webhook and the sweep can both try to
 * convert the same successful charge, and only one order results. Paid cycles
 * are online orders carrying the charge id; unpaid ones ship pay-on-delivery.
 */
export async function createCycleOrder(
  sub: InstanceType<typeof Subscription>,
  opts: { paid: boolean; chargeId?: string },
): Promise<InstanceType<typeof Order> | null> {
  if (opts.chargeId) {
    const existing = await Order.findOne({ 'cashfree.paymentId': opts.chargeId });
    if (existing) return null;
  }

  const customer = await Customer.findById(sub.customerId);
  if (!customer) return null;

  const reference = await nextOrderReference();
  const order = await Order.create({
    reference,
    customerId: sub.customerId,
    customerName: customer.name,
    customerEmail: customer.email,
    items: [
      {
        productId: sub.productId,
        tierId: sub.tierId,
        sku: sub.sku,
        name: sub.planName,
        tierName: '',
        packets: sub.packets,
        quantity: sub.quantity,
        unitPrice: sub.price,
      },
    ],
    subtotal: sub.price * sub.quantity,
    discount: 0,
    shippingFee: 0,
    total: sub.price * sub.quantity,
    channel: 'subscription',
    paymentMethod: opts.paid ? 'online' : 'cod',
    paymentStatus: 'pending',
    payment: { provider: opts.paid ? 'cashfree' : 'cod', method: opts.paid ? 'autopay' : '' },
    cashfree: opts.chargeId ? { paymentId: opts.chargeId } : {},
    status: 'placed',
    address: sub.address?.line1
      ? sub.address
      : customer.addresses[0] ?? { line1: '—', city: customer.city, state: customer.state, pincode: '' },
    timeline: [{ stage: 'placed', at: new Date() }],
    subscriptionId: sub.id,
    placedAt: new Date(),
  });

  await markOrderConfirmedPaid(order);
  sub.cyclesDelivered += 1;
  sub.nextDelivery = new Date(Date.now() + sub.intervalDays * 86400_000);
  await sub.save();
  await logEvent(
    'subscription',
    `Cycle order ${reference}`,
    `${customer.name} — ${sub.planName}${opts.paid ? ' (auto-paid)' : ''}`,
    `/orders/${order.id}`,
  );
  return order;
}
