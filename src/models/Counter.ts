import { Schema, model } from 'mongoose';

// Atomic sequences: order references (10X-1001), invoices (INV-2026-0001),
// returns (RET-101).

const counterSchema = new Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const Counter = model('Counter', counterSchema);

export async function nextSeq(name: string, start = 1000): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  // Fresh counters begin at `start + 1` so references look established.
  if (doc.seq === 1 && start > 0) {
    doc.seq = start + 1;
    await Counter.updateOne({ _id: name }, { $set: { seq: doc.seq } });
  }
  return doc.seq;
}

export const nextOrderReference = async () => `10X-${await nextSeq('order', 1000)}`;
export const nextReturnReference = async () => `RET-${await nextSeq('return', 100)}`;
export const nextQueryReference = async () => `Q-${await nextSeq('query', 1000)}`;
export const nextInvoiceNumber = async () => {
  const year = new Date().getFullYear();
  const n = await nextSeq(`invoice-${year}`, 0);
  return `INV-${year}-${String(n).padStart(4, '0')}`;
};
