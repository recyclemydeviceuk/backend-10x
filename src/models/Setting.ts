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
    /** 'free' waives the delivery fee on every order; 'priced' uses the numbers below. */
    deliveryMode: { type: String, enum: ['free', 'priced'], default: 'priced' },
    freeShippingOver: { type: Number, default: 999 },
    flatShipping: { type: Number, default: 49 },
    codEnabled: { type: Boolean, default: true },
    /** Days between subscription deliveries — drives the cadence everywhere. */
    subscriptionIntervalDays: { type: Number, default: 28 },
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
