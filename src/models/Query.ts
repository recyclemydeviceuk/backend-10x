import { Schema, model, type InferSchemaType } from 'mongoose';

// Customer questions from the storefront's contact form. Answered by the team
// in the admin panel; the reply is emailed back to whoever asked.

export const QUERY_TOPICS = [
  'product',
  'order',
  'subscription',
  'refund',
  'bulk',
  'stockist',
  'other',
  // Raised from the order-help chat: the customer wants support to phone them.
  'callback',
] as const;
export type QueryTopic = (typeof QUERY_TOPICS)[number];

export const QUERY_STATUSES = ['new', 'open', 'answered', 'closed'] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

const querySchema = new Schema(
  {
    /** Human-facing reference given to the customer on submit, e.g. Q-1042. */
    reference: { type: String, required: true, unique: true },
    topic: { type: String, enum: QUERY_TOPICS, required: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, default: '' },
    /** Only meaningful for order and refund topics. */
    orderReference: { type: String, default: '' },
    message: { type: String, required: true },
    status: { type: String, enum: QUERY_STATUSES, default: 'new' },
    reply: { type: String, default: '' },
    answeredAt: { type: Date, default: null },
    answeredBy: { type: String, default: '' },
  },
  { timestamps: true },
);

querySchema.index({ createdAt: -1 });
querySchema.index({ status: 1 });

export type QueryDoc = InferSchemaType<typeof querySchema>;
export const CustomerQuery = model('CustomerQuery', querySchema);
