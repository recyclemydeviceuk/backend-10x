import { Router } from 'express';
import { z } from 'zod';
import type { FilterQuery } from 'mongoose';
import { Customer, type CustomerDoc } from '../../models/Customer';
import { Order } from '../../models/Order';
import { Subscription } from '../../models/Subscription';
import { ReturnRequest } from '../../models/ReturnRequest';
import { logEvent } from '../../models/Event';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { ApiError } from '../../utils/ApiError';
import { pageQuery, pageMeta } from '../../utils/paginate';

export const adminCustomersRouter = Router();

const fields = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().default(''),
  city: z.string().trim().default(''),
  state: z.string().trim().default(''),
  marketingOptIn: z.boolean().default(false),
});

adminCustomersRouter.get(
  '/',
  requirePermission('customers.view'),
  asyncHandler(async (req, res) => {
    const q = pageQuery(req);
    const filter: FilterQuery<CustomerDoc> = {};
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { city: rx }];
    }
    if (req.query.subscribed === 'yes') filter.hasSubscription = true;
    if (req.query.subscribed === 'no') filter.hasSubscription = false;
    const [customers, total] = await Promise.all([
      Customer.find(filter).select('-passwordHash -passwordResetToken -passwordResetExpires').sort({ createdAt: -1 }).skip(q.skip).limit(q.per),
      Customer.countDocuments(filter),
    ]);
    res.json({ ok: true, customers, ...pageMeta(total, q) });
  }),
);

adminCustomersRouter.get(
  '/:id',
  requirePermission('customers.view'),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.params.id).select('-passwordHash -passwordResetToken -passwordResetExpires');
    if (!customer) throw ApiError.notFound('Customer not found.');
    const [orders, subscriptions, returns] = await Promise.all([
      Order.find({ customerId: customer.id }).sort({ placedAt: -1 }).limit(20),
      Subscription.find({ customerId: customer.id }).sort({ startedAt: -1 }),
      ReturnRequest.find({ customerId: customer.id }).sort({ createdAt: -1 }),
    ]);
    res.json({ ok: true, customer, orders, subscriptions, returns });
  }),
);

adminCustomersRouter.post(
  '/',
  requirePermission('customers.create'),
  validateBody(fields),
  asyncHandler(async (req, res) => {
    if (await Customer.findOne({ email: req.body.email })) {
      throw ApiError.conflict('That email already exists.');
    }
    const customer = await Customer.create({ ...req.body, lastActiveAt: new Date() });
    await logEvent('customer', `New customer ${customer.name}`, customer.email, `/customers/${customer.id}`);
    res.status(201).json({ ok: true, customer });
  }),
);

adminCustomersRouter.patch(
  '/:id',
  requirePermission('customers.edit'),
  validateBody(fields.partial()),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.params.id);
    if (!customer) throw ApiError.notFound('Customer not found.');
    if (req.body.email && req.body.email !== customer.email) {
      if (await Customer.findOne({ email: req.body.email })) throw ApiError.conflict('That email already exists.');
    }
    Object.assign(customer, req.body);
    await customer.save();
    res.json({ ok: true, customer });
  }),
);

adminCustomersRouter.delete(
  '/:id',
  requirePermission('customers.delete'),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.params.id);
    if (!customer) throw ApiError.notFound('Customer not found.');
    const orderCount = await Order.countDocuments({ customerId: customer.id });
    if (orderCount > 0) {
      throw ApiError.badRequest('Customers with order history can’t be deleted — their records are needed for accounts.');
    }
    await customer.deleteOne();
    res.json({ ok: true, message: `${customer.name} deleted.` });
  }),
);
