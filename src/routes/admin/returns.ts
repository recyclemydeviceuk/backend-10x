import { Router } from 'express';
import { z } from 'zod';
import { ReturnRequest } from '../../models/ReturnRequest';
import { Order } from '../../models/Order';
import { logEvent } from '../../models/Event';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { ApiError } from '../../utils/ApiError';
import { pageQuery, pageMeta } from '../../utils/paginate';
import { createShiprocketReturn, assignAwb, isShiprocketConfigured } from '../../services/shiprocket';
import { releaseStock } from '../../services/orderLifecycle';
import { createCashfreeRefund } from '../../services/cashfree';
import { emails } from '../../services/emails';

export const adminReturnsRouter = Router();

const notify = (ret: InstanceType<typeof ReturnRequest>) =>
  emails.returnUpdate({
    email: ret.customerEmail,
    name: ret.customerName,
    reference: ret.reference,
    orderReference: ret.orderReference,
    status: ret.status as 'requested' | 'approved' | 'received' | 'refunded' | 'rejected',
    amount: ret.amount,
    rejectReason: ret.rejectReason,
  });

adminReturnsRouter.get(
  '/',
  requirePermission('returns.view'),
  asyncHandler(async (req, res) => {
    const q = pageQuery(req);
    const filter: Record<string, unknown> = {};
    if (['requested', 'approved', 'received', 'refunded', 'rejected'].includes(String(req.query.status))) {
      filter.status = req.query.status;
    }
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ reference: rx }, { orderReference: rx }, { customerName: rx }, { customerEmail: rx }];
    }
    const [returns, total] = await Promise.all([
      ReturnRequest.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.per),
      ReturnRequest.countDocuments(filter),
    ]);
    res.json({ ok: true, returns, ...pageMeta(total, q) });
  }),
);

adminReturnsRouter.get(
  '/:id',
  requirePermission('returns.view'),
  asyncHandler(async (req, res) => {
    const ret = await ReturnRequest.findById(req.params.id);
    if (!ret) throw ApiError.notFound('Return not found.');
    const order = await Order.findById(ret.orderId);
    res.json({ ok: true, return: ret, order });
  }),
);

/** Approve → book reverse pickup (customer → warehouse) with Shiprocket. */
adminReturnsRouter.post(
  '/:id/approve',
  requirePermission('returns.approve'),
  validateBody(z.object({ pickup: z.enum(['shiprocket', 'manual']).optional() }).default({})),
  asyncHandler(async (req, res) => {
    const ret = await ReturnRequest.findById(req.params.id);
    if (!ret) throw ApiError.notFound('Return not found.');
    if (ret.status !== 'requested') throw ApiError.badRequest('Only requested returns can be approved.');
    const order = await Order.findById(ret.orderId);
    if (!order) throw ApiError.badRequest('The original order no longer exists.');

    // Approval must never depend on a courier integration: with no Shiprocket
    // keys — or a pickup the team wants to arrange themselves — the return
    // still has to move forward, or it is stuck at "requested" forever.
    const viaShiprocket =
      (req.body.pickup ?? ((await isShiprocketConfigured()) ? 'shiprocket' : 'manual')) === 'shiprocket';

    if (viaShiprocket) {
      const created = await createShiprocketReturn(ret, order);
      ret.shiprocket.orderId = String(created.order_id);
      ret.shiprocket.shipmentId = String(created.shipment_id);
      const awb = await assignAwb(String(created.shipment_id)).catch(() => null);
      if (awb?.response?.data?.awb_code) {
        ret.shiprocket.awb = awb.response.data.awb_code;
        ret.shiprocket.courier = awb.response.data.courier_name ?? '';
      }
      ret.notes.push({ by: req.admin!.name, text: 'Approved — reverse pickup booked.', at: new Date() });
    } else {
      ret.notes.push({
        by: req.admin!.name,
        text: 'Approved — pickup to be arranged manually (no courier booking made).',
        at: new Date(),
      });
    }

    ret.status = 'approved';
    ret.timeline.push({ stage: 'approved', at: new Date() });
    await ret.save();
    await logEvent('return', `${ret.reference} approved`, ret.customerName, `/returns/${ret.id}`);
    await notify(ret);
    res.json({ ok: true, return: ret });
  }),
);

adminReturnsRouter.post(
  '/:id/reject',
  requirePermission('returns.reject'),
  validateBody(z.object({ reason: z.string().trim().min(10, 'Give the customer a clear reason (10+ characters).') })),
  asyncHandler(async (req, res) => {
    const ret = await ReturnRequest.findById(req.params.id);
    if (!ret) throw ApiError.notFound('Return not found.');
    if (ret.status !== 'requested') throw ApiError.badRequest('Only requested returns can be rejected.');
    ret.status = 'rejected';
    ret.rejectReason = req.body.reason;
    ret.timeline.push({ stage: 'rejected', at: new Date() });
    ret.notes.push({ by: req.admin!.name, text: `Rejected: ${req.body.reason}`, at: new Date() });
    await ret.save();
    await notify(ret);
    res.json({ ok: true, return: ret });
  }),
);

adminReturnsRouter.post(
  '/:id/receive',
  requirePermission('returns.receive'),
  asyncHandler(async (req, res) => {
    const ret = await ReturnRequest.findById(req.params.id);
    if (!ret) throw ApiError.notFound('Return not found.');
    if (ret.status !== 'approved') throw ApiError.badRequest('Mark received once the return is approved and picked up.');
    ret.status = 'received';
    ret.timeline.push({ stage: 'received', at: new Date() });
    ret.notes.push({ by: req.admin!.name, text: 'Parcel received at the warehouse.', at: new Date() });
    await ret.save();

    // The goods are physically back — put them back on the shelf. releaseStock
    // is idempotent (atomic claim on stockReleased), so a double-click or an
    // earlier cancellation can't restock the same order twice.
    const order = await Order.findById(ret.orderId);
    if (order) {
      const restocked = await releaseStock(order);
      if (restocked) {
        order.notes.push({ by: req.admin!.name, text: 'Returned items added back to stock.', at: new Date() });
        await order.save();
        await logEvent('return', `${ret.orderReference} restocked`, 'Returned items back in inventory', '/inventory');
      }
    }

    await notify(ret);
    res.json({ ok: true, return: ret });
  }),
);

/** Refund: prepaid → Cashfree API; COD → recorded manual payout. Flips the order too. */
adminReturnsRouter.post(
  '/:id/refund',
  requirePermission('returns.refund'),
  asyncHandler(async (req, res) => {
    const ret = await ReturnRequest.findById(req.params.id);
    if (!ret) throw ApiError.notFound('Return not found.');
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
    ret.timeline.push({ stage: 'refunded', at: new Date() });
    ret.notes.push({
      by: req.admin!.name,
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
    await notify(ret);
    res.json({ ok: true, return: ret });
  }),
);

adminReturnsRouter.post(
  '/:id/notes',
  requirePermission('returns.notes'),
  validateBody(z.object({ text: z.string().trim().min(1) })),
  asyncHandler(async (req, res) => {
    const ret = await ReturnRequest.findById(req.params.id);
    if (!ret) throw ApiError.notFound('Return not found.');
    ret.notes.push({ by: req.admin!.name, text: req.body.text, at: new Date() });
    await ret.save();
    res.json({ ok: true, return: ret });
  }),
);
