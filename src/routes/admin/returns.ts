import { Router } from 'express';
import { z } from 'zod';
import { ReturnRequest } from '../../models/ReturnRequest';
import { Order } from '../../models/Order';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { ApiError } from '../../utils/ApiError';
import { pageQuery, pageMeta } from '../../utils/paginate';
import { approveReturn, receiveReturn, refundReturn, notifyReturn } from '../../services/returnLifecycle';

export const adminReturnsRouter = Router();

const notify = notifyReturn;

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
    await approveReturn(ret, { by: req.admin!.name, pickup: req.body.pickup });
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
    await receiveReturn(ret, { by: req.admin!.name });
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
    await refundReturn(ret, { by: req.admin!.name });
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
