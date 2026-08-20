import { Schema, model, type InferSchemaType } from 'mongoose';

const couponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: '' },
    type: { type: String, enum: ['percent', 'flat'], required: true },
    value: { type: Number, required: true, min: 1 },
    minOrderValue: { type: Number, default: 0 },
    /** Caps a percentage discount, in rupees. 0/absent = uncapped. */
    maxDiscount: { type: Number, default: null },
    usageLimit: { type: Number, default: null },
    perCustomerLimit: { type: Number, default: null },
    usedCount: { type: Number, default: 0 },
    startsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    active: { type: Boolean, default: true },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true },
);

export type CouponDoc = InferSchemaType<typeof couponSchema>;
export const Coupon = model('Coupon', couponSchema);
