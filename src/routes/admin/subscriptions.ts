import { Router } from 'express';
import { z } from 'zod';
import { Subscription } from '../../models/Subscription';
import { Customer } from '../../models/Customer';
import { nextSeq } from '../../models/Counter';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { ApiError } from '../../utils/ApiError';
import { pageQuery, pageMeta } from '../../utils/paginate';
import { logEvent } from '../../models/Event';
import { emails } from '../../services/emails';
import { sendAutopayReminder } from '../../services/autopayReminders';

export const adminSubscriptionsRouter = Router();

async function syncHasSubscription(customerId: unknown) {
  const active = await Subscription.exists({ customerId, status: { $in: ['active', 'paused'] } });
  await Customer.updateOne({ _id: customerId }, { $set: { hasSubscription: Boolean(active) } });
}

adminSubscriptionsRouter.get(
  '/',
  requirePermission('subscriptions.view'),
  asyncHandler(async (req, res) => {
    const q = pageQuery(req);
    const filter: Record<string, unknown> = {};
    if (['active', 'paused', 'cancelled'].includes(String(req.query.status))) filter.status = req.query.status;
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ reference: rx }, { planName: rx }];
    }
    const [subs, total] = await Promise.all([
      Subscription.find(filter).populate('customerId', 'name email').sort({ startedAt: -1 }).skip(q.skip).limit(q.per),
      Subscription.countDocuments(filter),
    ]);
    res.json({ ok: true, subscriptions: subs, ...pageMeta(total, q) });
  }),
);

adminSubscriptionsRouter.post(
  '/',
  requirePermission('subscriptions.create'),
  validateBody(
    z.object({
      customerId: z.string().min(1),
      productId: z.string().min(1),
      tierId: z.string().min(1),
      planName: z.string().trim().min(2),
      quantity: z.number().int().min(1).default(1),
      price: z.number().min(1),
      intervalDays: z.number().int().min(7).max(90).default(28),
      nextDelivery: z.coerce.date(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.body.customerId);
    if (!customer) throw ApiError.badRequest('Pick a customer.');
    const reference = `SUB-${await nextSeq('subscription', 100)}`;
    const sub = await Subscription.create({ ...req.body, reference, status: 'active' });
    await syncHasSubscription(customer._id);
    await logEvent('subscription', `New subscription ${reference}`, customer.name, '/subscriptions');
    await emails.subscriptionStarted({
      email: customer.email,
      name: customer.name,
      reference: sub.reference,
      planName: sub.planName,
      price: sub.price * sub.quantity,
      nextDelivery: sub.nextDelivery ?? null,
    });
    res.status(201).json({ ok: true, subscription: sub });
  }),
);

adminSubscriptionsRouter.patch(
  '/:id',
  requirePermission('subscriptions.edit'),
  validateBody(
    z.object({
      planName: z.string().trim().min(2).optional(),
      quantity: z.number().int().min(1).optional(),
      price: z.number().min(1).optional(),
      intervalDays: z.number().int().min(7).max(90).optional(),
      nextDelivery: z.coerce.date().nullable().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const sub = await Subscription.findById(req.params.id);
    if (!sub) throw ApiError.notFound('Subscription not found.');
    Object.assign(sub, req.body);
    await sub.save();
    res.json({ ok: true, subscription: sub });
  }),
);

adminSubscriptionsRouter.post(
  '/:id/status',
  validateBody(z.object({ status: z.enum(['active', 'paused', 'cancelled']) })),
  (req, res, next) => {
    const permission = req.body.status === 'cancelled' ? 'subscriptions.cancel' : 'subscriptions.pause';
    requirePermission(permission)(req, res, next);
  },
  asyncHandler(async (req, res) => {
    const sub = await Subscription.findById(req.params.id);
    if (!sub) throw ApiError.notFound('Subscription not found.');
    sub.status = req.body.status;
    sub.nextDelivery =
      req.body.status === 'active' ? new Date(Date.now() + sub.intervalDays * 86400_000) : null;
    await sub.save();
    await syncHasSubscription(sub.customerId);
    const customer = await Customer.findById(sub.customerId).select('name email');
    if (customer) {
      await emails.subscriptionUpdated({
        email: customer.email,
        name: customer.name,
        reference: sub.reference,
        planName: sub.planName,
        status: sub.status,
        nextDelivery: sub.nextDelivery ?? null,
      });
    }
    res.json({ ok: true, subscription: sub });
  }),
);

adminSubscriptionsRouter.delete(
  '/:id',
  requirePermission('subscriptions.delete'),
  asyncHandler(async (req, res) => {
    const sub = await Subscription.findById(req.params.id);
    if (!sub) throw ApiError.notFound('Subscription not found.');
    await sub.deleteOne();
    await syncHasSubscription(sub.customerId);
    res.json({ ok: true, message: `${sub.reference} deleted.` });
  }),
);

/**
 * Team-triggered auto-pay nudge. A mandate can only be approved by the
 * customer in their own bank/UPI app, so "set up auto-pay for them" means
 * sending them the link — this does that immediately, outside the cadence.
 * It still respects a customer who chose pay on delivery.
 */
adminSubscriptionsRouter.post(
  '/:id/autopay/remind',
  requirePermission('subscriptions.edit'),
  asyncHandler(async (req, res) => {
    const sub = await Subscription.findById(req.params.id);
    if (!sub) throw ApiError.notFound('Subscription not found.');
    const result = await sendAutopayReminder(sub, { force: true });
    if (!result.sent) throw ApiError.badRequest(result.reason ?? 'Reminder not sent.');
    res.json({ ok: true, reminders: sub.autopay.reminderCount, lastReminderAt: sub.autopay.lastReminderAt });
  }),
);
