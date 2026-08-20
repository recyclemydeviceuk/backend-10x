import { Coupon } from '../models/Coupon';
import { ApiError } from '../utils/ApiError';
import type { HydratedDocument } from 'mongoose';
import type { InferSchemaType } from 'mongoose';

type CouponDoc = HydratedDocument<InferSchemaType<(typeof Coupon)['schema']>>;

/**
 * What a coupon takes off a subtotal.
 *
 * Percentages round DOWN. "15% off" that hands back 15.01% is money given away
 * against the stated terms, and it happens on half of all subtotals. A cap is
 * applied after that, and the result can never exceed the subtotal itself.
 */
export function discountFor(
  coupon: Pick<CouponDoc, 'type' | 'value' | 'maxDiscount'>,
  subtotal: number,
): number {
  const raw = coupon.type === 'percent' ? Math.floor((subtotal * coupon.value) / 100) : coupon.value;
  const capped = coupon.maxDiscount && coupon.maxDiscount > 0 ? Math.min(raw, coupon.maxDiscount) : raw;
  return Math.max(0, Math.min(capped, subtotal));
}

/**
 * Resolve a code against a subtotal, or throw with a message that says what is
 * actually wrong — "add ₹300 more" sends people towards the fix, "invalid
 * coupon" sends them away.
 */
export async function resolveCoupon(code: string, subtotal: number): Promise<{ coupon: CouponDoc; discount: number }> {
  const coupon = (await Coupon.findOne({ code: code.trim().toUpperCase() })) as CouponDoc | null;
  if (!coupon || !coupon.active) throw ApiError.badRequest('That code is not valid.');

  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) throw ApiError.badRequest('That code is not active yet.');
  if (coupon.expiresAt && coupon.expiresAt < now) throw ApiError.badRequest('That code has expired.');
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    throw ApiError.badRequest('That code has been fully used.');
  }
  if (subtotal < coupon.minOrderValue) {
    const short = coupon.minOrderValue - subtotal;
    throw ApiError.badRequest(`Add ₹${short.toLocaleString('en-IN')} more to use this code.`);
  }

  return { coupon, discount: discountFor(coupon, subtotal) };
}
