import { Order, type OrderDoc, type OrderStatus } from '../models/Order';
import { PendingCheckout, type PendingCheckoutDoc } from '../models/PendingCheckout';
import { Types } from 'mongoose';
import { Product } from '../models/Product';
import { Customer } from '../models/Customer';
import { Coupon } from '../models/Coupon';
import { Subscription } from '../models/Subscription';
import { nextInvoiceNumber, nextSeq } from '../models/Counter';
import { getSettings } from '../models/Setting';
import { logEvent } from '../models/Event';
import { emails } from './emails';
import type { HydratedDocument } from 'mongoose';
import { ApiError } from '../utils/ApiError';

type OrderModel = HydratedDocument<OrderDoc>;

/** Stage progression used for timeline stamping. */
const STAGES: OrderStatus[] = ['placed', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered'];

export function stampTimeline(order: OrderModel, status: OrderStatus): void {
  const now = new Date();
  if (status === 'cancelled' || status === 'returned') {
    if (!order.timeline.some((t) => t.stage === status)) order.timeline.push({ stage: status, at: now });
    return;
  }
  const target = STAGES.indexOf(status);
  for (let i = 0; i <= target; i++) {
    if (!order.timeline.some((t) => t.stage === STAGES[i])) {
      order.timeline.push({ stage: STAGES[i], at: now });
    }
  }
}

/** Atomically reserves stock for every line, rolling earlier lines back on failure. */
export async function decrementStock(order: OrderDoc): Promise<void> {
  const allocated: { productId: unknown; tierId: string; quantity: number }[] = [];
  for (const item of order.items) {
    const result = await Product.updateOne(
      {
        _id: item.productId,
        status: 'active',
        tiers: { $elemMatch: { _id: item.tierId, available: true, stock: { $gte: item.quantity } } },
      },
      { $inc: { 'tiers.$[tier].stock': -item.quantity } },
      { arrayFilters: [{ 'tier._id': item.tierId, 'tier.available': true, 'tier.stock': { $gte: item.quantity } }] },
    );
    if (result.modifiedCount === 0) {
      for (const done of allocated) {
        await Product.updateOne(
          { _id: done.productId },
          { $inc: { 'tiers.$[tier].stock': done.quantity } },
          { arrayFilters: [{ 'tier._id': done.tierId }] },
        );
      }
      throw ApiError.conflict('A pack in this order just sold out. Refresh the cart and try again.');
    }
    allocated.push({ productId: item.productId, tierId: item.tierId, quantity: item.quantity });
  }
}

/** Returns previously allocated stock when an order is cancelled pre-dispatch. */
export async function incrementStock(order: OrderDoc): Promise<void> {
  for (const item of order.items) {
    await Product.updateOne(
      { _id: item.productId },
      { $inc: { 'tiers.$[tier].stock': item.quantity } },
      { arrayFilters: [{ 'tier._id': item.tierId }] },
    );
  }
}

/** Reserve inventory before a payment session is handed to the browser. */
export async function reserveStock(order: OrderModel): Promise<void> {
  if (order.stockAllocated && !order.stockReleased) return;
  await decrementStock(order);
  order.stockAllocated = true;
  order.stockReleased = false;
  await order.save();
}

/**
 * Idempotently release a reservation after cancellation, payment failure, or
 * a received return. Resolves true only for the call that actually restocked.
 */
export async function releaseStock(order: OrderModel): Promise<boolean> {
  if (!order.stockAllocated || order.stockReleased) return false;
  const claim = await Order.updateOne(
    { _id: order._id, stockAllocated: true, stockReleased: { $ne: true } },
    { $set: { stockReleased: true } },
  );
  if (claim.modifiedCount === 0) {
    order.stockReleased = true;
    return false;
  }
  try {
    await incrementStock(order);
    order.stockReleased = true;
    return true;
  } catch (error) {
    await Order.updateOne({ _id: order._id }, { $set: { stockReleased: false } });
    throw error;
  }
}

export async function markOrderPaymentFailed(order: OrderModel): Promise<void> {
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded') return;
  order.paymentStatus = 'failed';
  if (order.status === 'placed' || order.status === 'confirmed') {
    order.status = 'cancelled';
    stampTimeline(order, 'cancelled');
  }
  await releaseStock(order);
  await order.save();
  await refreshCustomerStats(order.customerId);
}

/** A subscription starts only after COD acceptance or confirmed online payment. */
async function activateSubscriptions(order: OrderModel): Promise<void> {
  if (order.subscriptionsActivated) return;
  const claim = await Order.updateOne(
    { _id: order._id, subscriptionsActivated: { $ne: true } },
    { $set: { subscriptionsActivated: true } },
  );
  if (claim.modifiedCount === 0) {
    order.subscriptionsActivated = true;
    return;
  }
  order.subscriptionsActivated = true;
  const lines = order.items.filter((item) => item.subscribe);
  if (!lines.length) return;

  try {
    const customer = await Customer.findById(order.customerId);
    if (!customer) throw new Error(`Customer missing for order ${order.reference}.`);
    const settings = await getSettings();
    const intervalDays = settings.store.subscriptionIntervalDays || 28;
    let firstSubscriptionId = order.subscriptionId;

    for (const [sourceLineIndex, line] of order.items.entries()) {
      if (!line.subscribe) continue;
      let subscription = await Subscription.findOne({ sourceOrderId: order._id, sourceLineIndex });
      if (!subscription) {
        const reference = `SUB-${await nextSeq('subscription', 100)}`;
        const nextDelivery = new Date(Date.now() + intervalDays * 86400_000);
        subscription = await Subscription.create({
          reference,
          sourceOrderId: order._id,
          sourceLineIndex,
          customerId: customer.id,
          customerName: customer.name,
          productId: line.productId,
          tierId: line.tierId,
          sku: line.sku,
          packets: line.packets,
          planName: `${line.name} — ${line.tierName}`,
          quantity: line.quantity,
          price: line.unitPrice,
          intervalDays,
          status: 'active',
          nextDelivery,
          address: order.address,
        });
        await emails.subscriptionStarted({
          email: customer.email,
          name: customer.name,
          planName: subscription.planName,
          price: line.unitPrice * line.quantity,
          nextDelivery,
        });
        await logEvent('subscription', `New subscription ${reference}`, customer.name, '/subscriptions');
      }
      if (!firstSubscriptionId) firstSubscriptionId = subscription._id;
    }

    customer.hasSubscription = true;
    customer.lastActiveAt = new Date();
    await customer.save();
    order.subscriptionId = firstSubscriptionId;
  } catch (error) {
    order.subscriptionsActivated = false;
    await Order.updateOne({ _id: order._id }, { $set: { subscriptionsActivated: false } });
    throw error;
  }
}

/** Refreshes the customer's denormalised order stats. */
export async function refreshCustomerStats(customerId: unknown): Promise<void> {
  const [agg] = await Order.aggregate([
    { $match: { customerId, status: { $ne: 'cancelled' } } },
    { $group: { _id: null, totalSpent: { $sum: '$total' }, ordersCount: { $sum: 1 } } },
  ]);
  await Customer.updateOne(
    { _id: customerId },
    {
      $set: {
        totalSpent: agg?.totalSpent ?? 0,
        ordersCount: agg?.ordersCount ?? 0,
        lastActiveAt: new Date(),
      },
    },
  );
}

/** Everything that happens the moment an order's money is in (or COD accepted). */
export async function markOrderConfirmedPaid(order: OrderModel, opts?: { skipEmail?: boolean }): Promise<void> {
  if (order.paymentMethod === 'online') order.paymentStatus = 'paid';
  order.payment.provider = order.paymentMethod === 'online' ? 'cashfree' : 'cod';
  if (!order.payment.capturedAt && order.paymentStatus === 'paid') order.payment.capturedAt = new Date();
  if (order.status === 'placed') {
    order.status = 'confirmed';
    stampTimeline(order, 'confirmed');
  }
  if (!order.invoiceNo) {
    const candidate = await nextInvoiceNumber();
    const invoiceClaim = await Order.updateOne(
      { _id: order._id, invoiceNo: '' },
      { $set: { invoiceNo: candidate } },
    );
    order.invoiceNo = invoiceClaim.modifiedCount > 0
      ? candidate
      : (await Order.findById(order._id).select('invoiceNo').lean())?.invoiceNo ?? candidate;
  }
  if (!order.stockAllocated) {
    await reserveStock(order);
  }
  if (order.couponCode && !order.couponCounted) {
    const couponClaim = await Order.updateOne(
      { _id: order._id, couponCounted: { $ne: true } },
      { $set: { couponCounted: true } },
    );
    if (couponClaim.modifiedCount > 0) {
      try {
        await Coupon.updateOne({ code: order.couponCode }, { $inc: { usedCount: 1 } });
      } catch (error) {
        await Order.updateOne({ _id: order._id }, { $set: { couponCounted: false } });
        throw error;
      }
    }
    order.couponCounted = true;
  }
  await activateSubscriptions(order);
  await order.save();
  await refreshCustomerStats(order.customerId);
  const notificationClaim = await Order.updateOne(
    { _id: order._id, confirmationNotified: { $ne: true } },
    { $set: { confirmationNotified: true } },
  );
  if (notificationClaim.modifiedCount > 0) {
    order.confirmationNotified = true;
    await logEvent(
      order.paymentMethod === 'online' ? 'payment' : 'order',
      `${order.reference} ${order.paymentMethod === 'online' ? 'paid' : 'confirmed'}`,
      `${order.customerName} — ₹${order.total.toLocaleString('en-IN')}`,
      `/orders/${order.id}`,
    );
    if (!opts?.skipEmail) await emails.orderConfirmed(order);
  }
}

/** Applies a status change with timeline + lifecycle emails. */
export async function applyStatusChange(order: OrderModel, status: OrderStatus): Promise<void> {
  const previous = order.status;
  order.status = status;
  stampTimeline(order, status);
  if (status === 'cancelled' && order.stockAllocated && !order.stockReleased) {
    await releaseStock(order);
  }
  // A cancelled order takes its courier booking down with it: whoever
  // cancelled (customer, panel, webhook), Shiprocket must stop the shipment
  // too, or the courier picks up a parcel nobody is paying for.
  if (status === 'cancelled' && previous !== 'cancelled') {
    await cancelShipmentBooking(order);
  }
  // Cash on delivery is collected at the door: the moment the courier says
  // delivered, the money exists and so does the invoice.
  if (status === 'delivered' && order.paymentMethod === 'cod' && order.paymentStatus === 'pending') {
    order.paymentStatus = 'paid';
    order.payment.provider = 'cod';
    order.payment.capturedAt = new Date();
    if (!order.invoiceNo) order.invoiceNo = await nextInvoiceNumber();
    await logEvent('payment', `${order.reference} collected on delivery`, `₹${order.total.toLocaleString('en-IN')}`, `/orders/${order.id}`);
  }
  await order.save();

  if (status === 'shipped' && previous !== 'shipped') await emails.orderShipped(order);
  if (status === 'delivered' && previous !== 'delivered') await emails.orderDelivered(order);
  if (status === 'cancelled' && previous !== 'cancelled') {
    await refreshCustomerStats(order.customerId);
    await emails.orderCancelled(order);
  }
}

/* ============================================ pending checkout → order */

/**
 * Turn a paid checkout into a real order.
 *
 * This is the ONLY place an online order comes into existence: no payment, no
 * order. It is idempotent by an atomic claim on the pending record, because
 * three things race to call it — the Cashfree webhook, the confirmation page,
 * and the payment sync — and all three must be able to fire safely.
 *
 * Stock is taken here rather than when the payment window opened. Holding
 * inventory for every abandoned card entry would starve the customers who do
 * pay; the trade is that a pack can sell out while someone is paying, which
 * `markOrderConfirmedPaid` surfaces by refusing the allocation.
 */
export async function materializePendingCheckout(
  pending: HydratedDocument<PendingCheckoutDoc>,
): Promise<HydratedDocument<OrderDoc> | null> {
  // Already converted — hand back the same order rather than making a second.
  if (pending.orderId) return Order.findById(pending.orderId);

  const existing = await Order.findOne({ reference: pending.reference });
  if (existing) {
    pending.orderId = existing._id;
    pending.status = 'paid';
    await pending.save();
    return existing;
  }

  // One caller wins the right to create the order.
  //
  // The id is minted up front so the claim can flip `orderId` from null in a
  // single atomic step. Claiming by setting `status` alone was not safe: two
  // callers both see null, and whether the second one "modifies" anything
  // depends on the value happening to change — which under a real race
  // (webhook and confirmation page together) produced a duplicate order.
  const orderId = new Types.ObjectId();
  const claim = await PendingCheckout.updateOne(
    { _id: pending._id, orderId: null },
    { $set: { orderId, status: 'paid' } },
  );
  if (claim.modifiedCount === 0) {
    // Someone else won the claim and is mid-create. Wait briefly for the order
    // to appear rather than returning null — the confirmation page would take
    // that as "still settling" and tell the customer their payment hadn't
    // landed when in fact it had.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const settled = await Order.findOne({ reference: pending.reference });
      if (settled) return settled;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return Order.findOne({ reference: pending.reference });
  }

  let order: HydratedDocument<OrderDoc>;
  try {
    order = await Order.create({
      _id: orderId,
      reference: pending.reference,
      customerId: pending.customerId,
      customerName: pending.customerName,
      customerEmail: pending.customerEmail,
      items: pending.items,
      subtotal: pending.subtotal,
      discount: pending.discount,
      shippingFee: pending.shippingFee,
      total: pending.total,
      couponCode: pending.couponCode,
      channel: 'website',
      paymentMethod: 'online',
      paymentStatus: 'pending',
      payment: { provider: 'cashfree' },
      status: 'placed',
      address: pending.address,
      timeline: [{ stage: 'placed', at: new Date() }],
      cashfree: {
        orderId: pending.cashfree.orderId,
        paymentSessionId: pending.cashfree.paymentSessionId,
      },
      placedAt: pending.createdAt ?? new Date(),
    });
  } catch (error) {
    // Release the claim so a later attempt can retry rather than stranding a
    // checkout that has been paid for.
    await PendingCheckout.updateOne(
      { _id: pending._id },
      { $set: { orderId: null, status: 'awaiting_payment' } },
    );
    throw error;
  }

  pending.orderId = order._id;
  pending.status = 'paid';

  await markOrderConfirmedPaid(order);
  return order;
}

/** Close a checkout the customer never completed. No order is ever created. */
export async function markPendingCheckoutFailed(
  pending: HydratedDocument<PendingCheckoutDoc>,
  status: 'failed' | 'abandoned' = 'failed',
): Promise<void> {
  if (pending.orderId || pending.status === 'paid') return;
  pending.status = status;
  await pending.save();
}

/**
 * Start the money back automatically when a PAID online order is cancelled.
 *
 * Called from every cancellation path — customer and panel — so nobody has to
 * remember to refund by hand. A gateway failure never blocks the cancellation:
 * the order is flagged for manual follow-up instead.
 */
/**
 * Cancel the Shiprocket booking that belongs to a cancelled order.
 *
 * Best-effort by design: a gateway hiccup must never block the cancellation
 * itself — the failure is written on the order and into the event feed so the
 * team cancels it by hand. Dynamic import keeps shiprocket out of this
 * module's import graph (same pattern as the Cashfree refund below).
 */
async function cancelShipmentBooking(order: OrderModel): Promise<void> {
  const srOrderId = order.shipment?.orderId;
  const alreadyDown = /cancel/i.test(order.shipment?.status ?? '');
  if (!srOrderId || order.shipment?.provider !== 'shiprocket' || alreadyDown) return;

  try {
    const { isShiprocketConfigured, cancelShiprocketOrder } = await import('./shiprocket');
    if (!(await isShiprocketConfigured())) return;
    await cancelShiprocketOrder(srOrderId);
    order.shipment.status = 'CANCELLED';
    order.shipment.lastSyncedAt = new Date();
    order.notes.push({ by: 'Sync', text: 'Shiprocket shipment cancelled with the order.', at: new Date() });
    await logEvent('order', `${order.reference} shipment cancelled`, 'Shiprocket booking stopped', `/orders/${order.id}`);
  } catch (error) {
    order.notes.push({
      by: 'Sync',
      text: `Shiprocket cancel FAILED — cancel booking ${srOrderId} by hand. (${error instanceof Error ? error.message : 'error'})`,
      at: new Date(),
    });
    await logEvent('order', `${order.reference} — cancel the Shiprocket booking by hand`, 'Automatic cancel failed', `/orders/${order.id}`);
  }
}

export async function autoRefundOnCancel(order: OrderModel): Promise<boolean> {
  if (order.paymentMethod !== 'online' || order.paymentStatus !== 'paid' || !order.cashfree.orderId) {
    return false;
  }
  try {
    const { createCashfreeRefund } = await import('./cashfree');
    const refund = await createCashfreeRefund({
      orderId: order.cashfree.orderId,
      refundId: `cancel-${order.reference}-${Date.now().toString(36)}`,
      amount: order.total,
      note: `Cancellation of ${order.reference}`,
    });
    order.cashfree.refundId = refund.refund_id;
    order.payment.refunds.push({
      refundId: refund.refund_id,
      amount: order.total,
      at: new Date(),
      note: 'Automatic refund on cancellation',
    });
    order.paymentStatus = 'refunded';
    order.notes.push({
      by: 'Automation',
      text: `₹${order.total.toLocaleString('en-IN')} refund started automatically.`,
      at: new Date(),
    });
    await order.save();
    await emails.orderRefunded(order);
    return true;
  } catch {
    order.notes.push({
      by: 'Automation',
      text: 'Automatic refund FAILED — refund manually from the Payment card.',
      at: new Date(),
    });
    await order.save();
    return false;
  }
}
