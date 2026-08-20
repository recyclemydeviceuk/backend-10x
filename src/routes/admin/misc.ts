import { Router } from 'express';
import type { FilterQuery } from 'mongoose';
import { Event } from '../../models/Event';
import { Order, type OrderDoc } from '../../models/Order';
import { asyncHandler } from '../../utils/asyncHandler';
import { requirePermission } from '../../middleware/adminAuth';
import { pageQuery, pageMeta } from '../../utils/paginate';

export const adminMiscRouter = Router();

/* -------------------------------------------- notifications / events feed */
adminMiscRouter.get(
  '/events',
  requirePermission('dashboard.view'),
  asyncHandler(async (req, res) => {
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const filter = since ? { createdAt: { $gt: since } } : {};
    const events = await Event.find(filter).sort({ createdAt: -1 }).limit(50);
    res.json({ ok: true, events });
  }),
);

/* ----------------------------------------- transactions = payments view of
   orders: every order has exactly one payment record (CF id or COD). */
adminMiscRouter.get(
  '/transactions',
  requirePermission('transactions.view'),
  asyncHandler(async (req, res) => {
    const q = pageQuery(req);
    const filter: FilterQuery<OrderDoc> = {};
    if (['pending', 'paid', 'refunded', 'failed'].includes(String(req.query.status))) {
      filter.paymentStatus = req.query.status;
    }
    if (req.query.method === 'online' || req.query.method === 'cod') filter.paymentMethod = req.query.method;
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ reference: rx }, { customerName: rx }, { 'cashfree.orderId': rx }, { invoiceNo: rx }];
    }
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .select('reference customerName customerEmail total paymentMethod paymentStatus cashfree invoiceNo placedAt')
        .sort({ placedAt: -1 })
        .skip(q.skip)
        .limit(q.per),
      Order.countDocuments(filter),
    ]);
    res.json({ ok: true, transactions: orders, ...pageMeta(total, q) });
  }),
);
