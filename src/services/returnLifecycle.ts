import { ReturnRequest } from '../models/ReturnRequest';
import { Order } from '../models/Order';
import { logEvent } from '../models/Event';
import { ApiError } from '../utils/ApiError';
import { createShiprocketReturn, assignAwb, requestPickup, isShiprocketConfigured } from './shiprocket';
import { releaseStock } from './orderLifecycle';
import { createCashfreeRefund } from './cashfree';
import { emails } from './emails';

// =========================================================
// The return journey, in one place — used by the panel's buttons AND the
// syncing worker, so a return moves the same way whether a person or the
// courier's scan pushed it:
//
//   requested → approved  (reverse pickup booked, courier assigned, pickup requested)
//   approved  → received  (parcel back at the warehouse; stock restored)
//   received  → refunded  (Cashfree refund for prepaid; COD flagged for payout)
// =========================================================

type Ret = InstanceType<typeof ReturnRequest>;

export const notifyReturn = (ret: Ret) =>
  emails.returnUpdate({
    email: ret.customerEmail,
    name: ret.customerName,
    reference: ret.reference,
    orderReference: ret.orderReference,
    status: ret.status as 'requested' | 'approved' | 'received' | 'refunded' | 'rejected',
    amount: ret.amount,
    rejectReason: ret.rejectReason,
  });

/** Approve and, when Shiprocket is on, book the reverse pickup end to end. */
export async function approveReturn(
  ret: Ret,
  opts: { by: string; pickup?: 'shiprocket' | 'manual' },
): Promise<void> {
  if (ret.status !== 'requested') throw ApiError.badRequest('Only requested returns can be approved.');
  const order = await Order.findById(ret.orderId);
  if (!order) throw ApiError.badRequest('The original order no longer exists.');

  const viaShiprocket = (opts.pickup ?? ((await isShiprocketConfigured()) ? 'shiprocket' : 'manual')) === 'shiprocket';

  if (viaShiprocket) {
    const created = await createShiprocketReturn(ret, order);
    ret.shiprocket.orderId = String(created.order_id);
    ret.shiprocket.shipmentId = String(created.shipment_id);
    const awb = await assignAwb(String(created.shipment_id)).catch(() => null);
    if (awb?.response?.data?.awb_code) {
      ret.shiprocket.awb = awb.response.data.awb_code;
      ret.shiprocket.courier = awb.response.data.courier_name ?? '';
      try {
        await requestPickup(String(created.shipment_id));
        ret.shiprocket.pickupRequestedAt = new Date();
      } catch {
        /* the worker keeps asking */
      }
    }
    ret.notes.push({ by: opts.by, text: 'Approved — reverse pickup booked with the courier.', at: new Date() });
  } else {
    ret.notes.push({ by: opts.by, text: 'Approved — pickup to be arranged by the team (no courier booking made).', at: new Date() });
  }

  ret.status = 'approved';
  ret.timeline.push({ stage: 'approved', at: new Date() });
  await ret.save();
  await logEvent('return', `${ret.reference} approved`, ret.customerName, `/returns/${ret.id}`);
  await notifyReturn(ret);
}

/** The parcel is back: restock (idempotent) and open the refund step. */
export async function receiveReturn(ret: Ret, opts: { by: string }): Promise<void> {
  if (ret.status !== 'approved') throw ApiError.badRequest('Mark received once the return is approved and picked up.');
  ret.status = 'received';
  ret.timeline.push({ stage: 'received', at: new Date() });
  ret.notes.push({ by: opts.by, text: 'Parcel received at the warehouse.', at: new Date() });
  await ret.save();

  const order = await Order.findById(ret.orderId);
  if (order) {
    const restocked = await releaseStock(order);
    if (restocked) {
      order.notes.push({ by: opts.by, text: 'Returned items added back to stock.', at: new Date() });
      await order.save();
      await logEvent('return', `${ret.orderReference} restocked`, 'Returned items back in inventory', '/inventory');
    }
  }
  await notifyReturn(ret);
}

/**
 * Send the money back. Prepaid → Cashfree, against the original payment.
 * COD → there is no account to send to, so it is recorded as a manual
 * payout for the team to make by bank transfer.
 */
export async function refundReturn(ret: Ret, opts: { by: string }): Promise<{ mode: 'cashfree' | 'manual' }> {
  if (ret.status !== 'received') throw ApiError.badRequest('Refund once the parcel is received.');
  const order = await Order.findById(ret.orderId);
  if (order && order.paymentStatus === 'refunded') {
    throw ApiError.badRequest(`${order.reference} has already been refunded — nothing more to send back.`);
  }

  if (ret.isPrepaid && order?.cashfree.orderId) {
    const refund = await createCashfreeRefund({
      orderId: order.cashfree.orderId,
      refundId: `refund-${ret.reference}-${Date.now().toString(36)}`,
      amount: ret.amount,
      note: `Return ${ret.reference}`,
    });
    ret.refund.mode = 'cashfree';
    ret.refund.refundId = refund.refund_id;
  } else {
    ret.refund.mode = 'manual';
  }
  ret.refund.at = new Date();
  ret.status = 'refunded';
  ret.resolvedAt = new Date();
  ret.timeline.push({ stage: 'refunded', at: new Date() });
  ret.notes.push({
    by: opts.by,
    text: `Refund of ₹${ret.amount.toLocaleString('en-IN')} issued (${ret.refund.mode}).`,
    at: new Date(),
  });
  await ret.save();

  if (order) {
    order.status = 'returned';
    order.paymentStatus = 'refunded';
    if (ret.refund.refundId) order.cashfree.refundId = ret.refund.refundId;
    order.payment.refunds.push({
      refundId: ret.refund.refundId || '',
      amount: ret.amount,
      at: new Date(),
      note: `Return ${ret.reference}${ret.refund.mode === 'manual' ? ' (manual payout)' : ''}`,
    });
    if (!order.timeline.some((t) => t.stage === 'returned')) {
      order.timeline.push({ stage: 'returned', at: new Date() });
    }
    await order.save();
  }
  await logEvent('return', `${ret.reference} refunded`, `₹${ret.amount.toLocaleString('en-IN')}`, `/returns/${ret.id}`);
  await notifyReturn(ret);
  return { mode: ret.refund.mode as 'cashfree' | 'manual' };
}
