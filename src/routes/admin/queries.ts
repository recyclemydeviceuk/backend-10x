import { Router } from 'express';
import { z } from 'zod';
import type { FilterQuery } from 'mongoose';
import { CustomerQuery, QUERY_STATUSES, QUERY_TOPICS, type QueryDoc } from '../../models/Query';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requireAdminPermission } from '../../middleware/adminPermission';
import { ApiError } from '../../utils/ApiError';
import { pageQuery, pageMeta } from '../../utils/paginate';
import { emails } from '../../services/emails';

// Every query operation requires the primary admin's backend JWT.
export const adminQueriesRouter = Router();

adminQueriesRouter.get(
  '/',
  requireAdminPermission('queries.view'),
  asyncHandler(async (req, res) => {
    const q = pageQuery(req);
    const filter: FilterQuery<QueryDoc> = {};
    if (QUERY_STATUSES.includes(req.query.status as never)) filter.status = req.query.status;
    if (QUERY_TOPICS.includes(req.query.topic as never)) filter.topic = req.query.topic;
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ reference: rx }, { name: rx }, { email: rx }, { message: rx }];
    }

    const [queries, total, counts] = await Promise.all([
      CustomerQuery.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.per),
      CustomerQuery.countDocuments(filter),
      CustomerQuery.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);

    res.json({
      ok: true,
      queries,
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
      ...pageMeta(total, q),
    });
  }),
);

adminQueriesRouter.get(
  '/:id',
  requireAdminPermission('queries.view'),
  asyncHandler(async (req, res) => {
    const query = await CustomerQuery.findById(req.params.id);
    if (!query) throw ApiError.notFound('Query not found.');
    res.json({ ok: true, query });
  }),
);

/** Answer it. The reply is emailed to whoever asked. */
adminQueriesRouter.post(
  '/:id/reply',
  requireAdminPermission('queries.reply'),
  validateBody(z.object({ reply: z.string().trim().min(2), close: z.boolean().optional().default(false) })),
  asyncHandler(async (req, res) => {
    const query = await CustomerQuery.findById(req.params.id);
    if (!query) throw ApiError.notFound('Query not found.');

    query.reply = req.body.reply;
    query.answeredAt = new Date();
    query.answeredBy = req.admin!.name;
    query.status = req.body.close ? 'closed' : 'answered';
    await query.save();

    await emails.queryAnswered({
      email: query.email,
      name: query.name,
      reference: query.reference,
      reply: query.reply,
    });

    res.json({ ok: true, query });
  }),
);

adminQueriesRouter.patch(
  '/:id/status',
  requireAdminPermission('queries.manage'),
  validateBody(z.object({ status: z.enum(QUERY_STATUSES) })),
  asyncHandler(async (req, res) => {
    const query = await CustomerQuery.findByIdAndUpdate(
      req.params.id,
      { $set: { status: req.body.status } },
      { new: true },
    );
    if (!query) throw ApiError.notFound('Query not found.');
    res.json({ ok: true, query });
  }),
);

adminQueriesRouter.delete(
  '/:id',
  requireAdminPermission('queries.delete'),
  asyncHandler(async (req, res) => {
    const query = await CustomerQuery.findByIdAndDelete(req.params.id);
    if (!query) throw ApiError.notFound('Query not found.');
    res.json({ ok: true, message: `${query.reference} deleted.` });
  }),
);
