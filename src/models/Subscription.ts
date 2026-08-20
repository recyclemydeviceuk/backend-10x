import { Schema, model, type InferSchemaType } from 'mongoose';

const subAddressSchema = new Schema(
  {
    fullName: { type: String, default: '' },
    line1: { type: String, default: '' },
    line2: { type: String, default: '' },
    landmark: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    pincode: { type: String, default: '' },
    phone: { type: String, default: '' },
  },
  { _id: false },
);

/**
 * The Cashfree mandate behind a subscription, when the customer has set up
 * auto-pay. Absent (`status: ''`) = cycles generate as pay-on-delivery.
 */
const autopaySchema = new Schema(
  {
    /** Cashfree's subscription id — ours, passed through. */
    subscriptionId: { type: String, default: '' },
    status: {
      type: String,
      enum: ['', 'initialized', 'active', 'paused', 'cancelled', 'failed'],
      default: '',
    },
    authorizedAt: { type: Date, default: null },
    /** The charge currently in flight for a cycle, if any. */
    pendingChargeId: { type: String, default: '' },
    pendingChargeAt: { type: Date, default: null },
    lastChargeStatus: { type: String, default: '' },
  },
  { _id: false },
);

const subscriptionSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, default: '' },
    /** Makes subscription activation idempotent when payment callbacks repeat. */
    sourceOrderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    sourceLineIndex: { type: Number, default: null },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    tierId: { type: String, required: true },
    sku: { type: String, default: '' },
    packets: { type: String, default: '' },
    planName: { type: String, required: true },
    quantity: { type: Number, default: 1, min: 1 },
    price: { type: Number, required: true },
    /** Days between deliveries. */
    intervalDays: { type: Number, default: 28 },
    status: { type: String, enum: ['active', 'paused', 'cancelled'], default: 'active' },
    nextDelivery: { type: Date, default: null },
    cyclesDelivered: { type: Number, default: 0 },
    startedAt: { type: Date, default: () => new Date() },
    autopay: { type: autopaySchema, required: true, default: () => ({}) },
    address: { type: subAddressSchema, required: true, default: () => ({}) },
  },
  { timestamps: true },
);

subscriptionSchema.index(
  { sourceOrderId: 1, sourceLineIndex: 1 },
  { unique: true, partialFilterExpression: { sourceOrderId: { $type: 'objectId' } } },
);

export type SubscriptionDoc = InferSchemaType<typeof subscriptionSchema>;
export const Subscription = model('Subscription', subscriptionSchema);
