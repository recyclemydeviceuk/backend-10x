import { Schema, model, type InferSchemaType } from 'mongoose';

export const RETURN_STATUSES = ['requested', 'approved', 'received', 'refunded', 'rejected'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

const srLinkSchema = new Schema(
  {
    orderId: { type: String, default: '' },
    shipmentId: { type: String, default: '' },
    awb: { type: String, default: '' },
    courier: { type: String, default: '' },
    scheduledAt: { type: Date, default: null },
  },
  { _id: false },
);

const refundSchema = new Schema(
  {
    mode: { type: String, enum: ['', 'cashfree', 'manual'], default: '' },
    refundId: { type: String, default: '' },
    at: { type: Date, default: null },
  },
  { _id: false },
);

const returnSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    orderReference: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true },
    customerEmail: { type: String, required: true, lowercase: true },
    reason: { type: String, required: true },
    description: { type: String, required: true },
    /** S3 URLs. */
    photos: { type: [String], default: [] },
    amount: { type: Number, required: true },
    isPrepaid: { type: Boolean, required: true },
    status: { type: String, enum: RETURN_STATUSES, default: 'requested' },
    rejectReason: { type: String, default: '' },
    /** When it reached a terminal state (refunded or rejected). */
    resolvedAt: { type: Date, default: null },
    /** Shiprocket reverse-pickup linkage. */
    shiprocket: { type: srLinkSchema, required: true, default: () => ({}) },
    refund: { type: refundSchema, required: true, default: () => ({}) },
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
    timeline: {
      type: [
        new Schema(
          { stage: { type: String, required: true }, at: { type: Date, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

export type ReturnRequestDoc = InferSchemaType<typeof returnSchema>;
export const ReturnRequest = model('ReturnRequest', returnSchema);
