import { Schema, model, type InferSchemaType } from 'mongoose';

export const ORDER_STATUSES = [
  'placed',
  'confirmed',
  'packed',
  'shipped',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'returned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const itemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    tierId: { type: String, required: true },
    /** Human SKU shown on invoices and in the panel. */
    sku: { type: String, default: '' },
    name: { type: String, required: true },
    tierName: { type: String, default: '' },
    /** Pack description, e.g. "10 Stick Packets". */
    packets: { type: String, default: '' },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    /** Whether this line should become a recurring subscription after payment. */
    subscribe: { type: Boolean, default: false },
  },
  { _id: false },
);

const addressSchema = new Schema(
  {
    /** Recipient — printed on the invoice and the shipping label. */
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

const cashfreeSchema = new Schema(
  {
    orderId: { type: String, default: '' },
    paymentSessionId: { type: String, default: '' },
    paymentId: { type: String, default: '' },
    refundId: { type: String, default: '' },
  },
  { _id: false },
);

/**
 * Money movement on the order — how it was collected and everything that has
 * been sent back. Refunds are a list because a partial refund can be followed
 * by another; a single field would quietly overwrite the first one.
 */
const paymentSchema = new Schema(
  {
    provider: { type: String, enum: ['cashfree', 'cod', ''], default: '' },
    /** upi / card / netbanking … as reported by the gateway. */
    method: { type: String, default: '' },
    capturedAt: { type: Date, default: null },
    refunds: {
      type: [
        new Schema(
          {
            refundId: { type: String, default: '' },
            amount: { type: Number, required: true },
            at: { type: Date, required: true },
            note: { type: String, default: '' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { _id: false },
);

const shipmentSchema = new Schema(
  {
    provider: { type: String, enum: ['shiprocket', 'manual', ''], default: '' },
    shipmentId: { type: String, default: '' },
    orderId: { type: String, default: '' },
    awb: { type: String, default: '' },
    courier: { type: String, default: '' },
    /** Courier's own status string, verbatim. */
    status: { type: String, default: '' },
    createdAt: { type: Date, default: null },
    pickupRequestedAt: { type: Date, default: null },
    labelUrl: { type: String, default: '' },
    invoiceUrl: { type: String, default: '' },
    lastSyncedAt: { type: Date, default: null },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
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
    /** 'website' = one-time purchase, 'subscription' = subscription cycle. */
    channel: { type: String, enum: ['website', 'subscription'], default: 'website' },
    paymentMethod: { type: String, enum: ['online', 'cod'], required: true },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'refunded', 'failed'], default: 'pending' },
    status: { type: String, enum: ORDER_STATUSES, default: 'placed' },
    address: { type: addressSchema, required: true },
    timeline: {
      type: [
        new Schema(
          { stage: { type: String, required: true }, at: { type: Date, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
    notes: {
      type: [
        new Schema(
          {
            by: { type: String, required: true },
            text: { type: String, required: true },
            at: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Cashfree linkage. */
    cashfree: { type: cashfreeSchema, required: true, default: () => ({}) },
    /** Collection + refund record. */
    payment: { type: paymentSchema, required: true, default: () => ({}) },
    /** Shiprocket linkage. */
    shipment: { type: shipmentSchema, required: true, default: () => ({}) },
    courier: { type: String, default: '' },
    trackingNumber: { type: String, default: '' },
    invoiceNo: { type: String, default: '' },
    /** Promised delivery date, from the courier or set by hand. */
    estimatedDelivery: { type: Date, default: null },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', default: null },
    /** Lifecycle guards keep repeated payment webhooks idempotent. */
    stockAllocated: { type: Boolean, default: false },
    stockReleased: { type: Boolean, default: false },
    couponCounted: { type: Boolean, default: false },
    subscriptionsActivated: { type: Boolean, default: false },
    confirmationNotified: { type: Boolean, default: false },
    placedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

orderSchema.index({ customerId: 1, placedAt: -1 });
orderSchema.index({ status: 1 });
orderSchema.index({ placedAt: -1 });

export type OrderDoc = InferSchemaType<typeof orderSchema>;
export const Order = model('Order', orderSchema);
