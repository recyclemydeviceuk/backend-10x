import { Schema, model } from 'mongoose';

const cartSessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    line: { type: Schema.Types.Mixed, default: null },
    couponCode: { type: String, default: '' },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);

export const CartSession = model('CartSession', cartSessionSchema);
