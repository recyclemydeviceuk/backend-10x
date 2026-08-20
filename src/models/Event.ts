import { Schema, model, type InferSchemaType } from 'mongoose';

// Activity feed — powers the admin panel's notification bell.

const eventSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['order', 'customer', 'subscription', 'payment', 'return', 'query'],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, default: '' },
    href: { type: String, default: '' },
  },
  { timestamps: true },
);

eventSchema.index({ createdAt: -1 });

export type EventDoc = InferSchemaType<typeof eventSchema>;
export const Event = model('Event', eventSchema);

export async function logEvent(
  type: 'order' | 'customer' | 'subscription' | 'payment' | 'return' | 'query',
  title: string,
  message = '',
  href = '',
): Promise<void> {
  try {
    await Event.create({ type, title, message, href });
  } catch (err) {
    console.error('[events] failed to log:', err);
  }
}
