import { Schema, model, type InferSchemaType } from 'mongoose';

// =========================================================
// A checkout that is waiting on payment.
//
// NOT an order. An order means "we owe this person goods" —
// creating one before the money arrives fills the order list,
// the analytics and the stock counts with things that never
// happened, which is exactly what abandoned card entry does.
//
// So an online checkout parks everything it needs here, and an
// Order is created only once the gateway confirms payment. COD
// skips this entirely: nothing is being collected up front, so
// the order is real the moment it is placed.
//
// Keeping a record BEFORE sending someone to the gateway still
// matters — otherwise a payment could land with nothing on our
// side saying what it was for.
// =========================================================

const itemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    tierId: { type: String, required: true },
    sku: { type: String, default: '' },
    name: { type: String, required: true },
    tierName: { type: String, default: '' },
    packets: { type: String, default: '' },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    /** This line starts a subscription when the order is created. */
    subscribe: { type: Boolean, default: false },
  },
  { _id: false },
);

const addressSchema = new Schema(
  {
    fullName: { type: String, default: '' },
    line1: { type: String, required: true },
    line2: { type: String, default: '' },
    landmark: { type: String, default: '' },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    phone: { type: String, default: '' },
  },
  { _id: false },
);

const pendingCheckoutSchema = new Schema(
  {
    /** The reference the order will carry once it exists. */
    reference: { type: String, required: true, unique: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true },
    customerEmail: { type: String, required: true, lowercase: true },
    items: { type: [itemSchema], required: true },
    subtotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    shippingFee: { type: Number, default: 0 },
    total: { type: Number, required: true },
    couponCode: { type: String, default: '' },
    address: { type: addressSchema, required: true },
    cashfree: {
      type: new Schema(
        { orderId: { type: String, default: '' }, paymentSessionId: { type: String, default: '' } },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },
    status: {
      type: String,
      enum: ['awaiting_payment', 'paid', 'failed', 'abandoned'],
      default: 'awaiting_payment',
    },
    /** Set once the order exists — the guard that makes payment idempotent. */
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    /** Swept away automatically; an unpaid checkout is not worth keeping. */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Mongo removes these on its own once they lapse, so abandoned card entry
// never accumulates.
pendingCheckoutSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
pendingCheckoutSchema.index({ status: 1, createdAt: -1 });

export type PendingCheckoutDoc = InferSchemaType<typeof pendingCheckoutSchema>;
export const PendingCheckout = model('PendingCheckout', pendingCheckoutSchema);
