import { Router } from 'express';
import { z } from 'zod';
import { Coupon } from '../../models/Coupon';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { ApiError } from '../../utils/ApiError';
import { pageQuery, pageMeta } from '../../utils/paginate';

export const adminCouponsRouter = Router();

const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/, 'Codes: 3–20 letters, numbers or dashes.'),
  /**
   * Doubles as the promotion switch: a described coupon is surfaced on the
   * storefront cart as a suggestion chip, an undescribed one stays private.
   * Dropping this silently was why featured chips never appeared.
   */
  description: z.string().trim().max(120).default(''),
  type: z.enum(['percent', 'flat']),
  value: z.number().min(1),
  minOrderValue: z.number().min(0).default(0),
  usageLimit: z.number().int().min(1).nullable().default(null),
  expiresAt: z.coerce.date().nullable().default(null),
  active: z.boolean().default(true),
});

adminCouponsRouter.get(
  '/',
  requirePermission('coupons.view'),
  asyncHandler(async (req, res) => {
    const q = pageQuery(req);
    const filter: Record<string, unknown> = {};
    if (req.query.q) filter.code = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (req.query.state === 'active') filter.active = true;
    if (req.query.state === 'inactive') filter.active = false;
    const [coupons, total] = await Promise.all([
      Coupon.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.per),
      Coupon.countDocuments(filter),
    ]);
    res.json({ ok: true, coupons, ...pageMeta(total, q) });
  }),
);

adminCouponsRouter.post(
  '/',
  requirePermission('coupons.create'),
  validateBody(couponSchema),
  asyncHandler(async (req, res) => {
    if (req.body.type === 'percent' && req.body.value > 90) throw ApiError.badRequest('Percent discounts cap at 90%.');
    if (await Coupon.findOne({ code: req.body.code })) throw ApiError.conflict('That code already exists.');
    const coupon = await Coupon.create(req.body);
    res.status(201).json({ ok: true, coupon });
  }),
);

adminCouponsRouter.patch(
  '/:id',
  requirePermission('coupons.edit'),
  validateBody(couponSchema.partial()),
  asyncHandler(async (req, res) => {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) throw ApiError.notFound('Coupon not found.');
    if (req.body.code && req.body.code !== coupon.code) {
      if (await Coupon.findOne({ code: req.body.code })) throw ApiError.conflict('That code already exists.');
    }
    Object.assign(coupon, req.body);
    await coupon.save();
    res.json({ ok: true, coupon });
  }),
);

adminCouponsRouter.post(
  '/:id/toggle',
  requirePermission('coupons.toggle'),
  asyncHandler(async (req, res) => {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) throw ApiError.notFound('Coupon not found.');
    coupon.active = !coupon.active;
    await coupon.save();
    res.json({ ok: true, coupon });
  }),
);

adminCouponsRouter.delete(
  '/:id',
  requirePermission('coupons.delete'),
  asyncHandler(async (req, res) => {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) throw ApiError.notFound('Coupon not found.');
    await coupon.deleteOne();
    res.json({ ok: true, message: `${coupon.code} deleted.` });
  }),
);
