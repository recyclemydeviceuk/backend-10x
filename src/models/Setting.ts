import { Schema, model } from 'mongoose';

// Single non-secret store settings document (key 'store'). Integration
// credentials never enter this schema; they are read only from the backend env.

const storeSchema = new Schema(
  {
    name: { type: String, default: '10X' },
    supportEmail: { type: String, default: 'support@10xdrink.com' },
    supportPhone: { type: String, default: '' },
    /** When true the storefront shows only the coming-soon page (legal pages stay up). */
    comingSoonMode: { type: Boolean, default: false },
    /**
     * 'free'   — no delivery fee, ever.
     * 'priced' — flat fee below the free-delivery threshold.
     * 'live'   — the real Shiprocket rate for the customer's pincode, fetched
     *            as they shop; the flat fee is the fallback when Shiprocket
     *            can't quote. The threshold still applies.
     */
    deliveryMode: { type: String, enum: ['free', 'priced', 'live'], default: 'priced' },
    freeShippingOver: { type: Number, default: 999 },
    flatShipping: { type: Number, default: 49 },
    codEnabled: { type: Boolean, default: true },
    /** Days between subscription deliveries — drives the cadence everywhere. */
    subscriptionIntervalDays: { type: Number, default: 28 },
    /** Days between auto-pay set-up reminders for subscribers without a mandate. 0 = off. */
    autopayReminderEveryDays: { type: Number, default: 3 },
    /** How many reminders before we stop nudging a plan. */
    autopayReminderMax: { type: Number, default: 5 },
  },
  { _id: false },
);

const warehouseSchema = new Schema(
  {
    name: { type: String, default: '10X Fulfilment Centre' },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    pincode: { type: String, default: '' },
    phone: { type: String, default: '' },
  },
  { _id: false },
);

const automationSchema = new Schema(
  {
    autoShipments: { type: Boolean, default: false },
    /**
     * Approve return requests automatically (the 7-day window and
     * one-open-return-per-order rules are already enforced when the customer
     * files). Receiving and refunding are always automatic once the courier
     * brings the parcel back.
     */
    autoApproveReturns: { type: Boolean, default: true },
    autoTrackingSync: { type: Boolean, default: false },
    autoPaymentSync: { type: Boolean, default: false },
    autoSubscriptionCycles: { type: Boolean, default: false },
    lastRunAt: { type: Date, default: null },
    log: {
      type: [
        new Schema(
          { at: { type: Date, required: true }, text: { type: String, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { _id: false },
);

const settingSchema = new Schema(
  {
    _id: { type: String, default: 'store' },
    store: { type: storeSchema, required: true, default: () => ({}) },
    warehouse: { type: warehouseSchema, required: true, default: () => ({}) },
    automation: { type: automationSchema, required: true, default: () => ({}) },
  },
  { versionKey: false, timestamps: true },
);

export const Setting = model('Setting', settingSchema);

export async function getSettings() {
  return Setting.findOneAndUpdate(
    { _id: 'store' },
    { $setOnInsert: { _id: 'store' } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}
