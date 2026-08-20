import { Schema, model, type InferSchemaType } from 'mongoose';

const addressSchema = new Schema(
  {
    label: { type: String, default: 'Home' },
    /** Who receives the parcel — may differ from the account holder. */
    fullName: { type: String, default: '' },
    line1: { type: String, required: true },
    line2: { type: String, default: '' },
    landmark: { type: String, default: '' },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    phone: { type: String, default: '' },
    /** Exactly one address is the default; the storefront enforces it. */
    isDefault: { type: Boolean, default: false },
  },
  { _id: true },
);

/**
 * The cart the customer currently has open, mirrored from the storefront.
 *
 * Display only — the checkout still prices from the catalogue, so nothing here
 * is ever trusted as an amount. It exists so the team can see what someone is
 * about to buy (or has abandoned) when they call in.
 */
const cartSchema = new Schema(
  {
    items: {
      type: [
        new Schema(
          {
            productId: { type: Schema.Types.ObjectId, ref: 'Product' },
            tierId: { type: String, default: '' },
            sku: { type: String, default: '' },
            name: { type: String, required: true },
            packets: { type: String, default: '' },
            quantity: { type: Number, required: true, min: 1 },
            price: { type: Number, required: true, min: 0 },
            isSubscription: { type: Boolean, default: false },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const customerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    /** Empty for admin-created customers who never set a password. */
    passwordHash: { type: String, default: '' },
    addresses: { type: [addressSchema], default: [] },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    marketingOptIn: { type: Boolean, default: false },
    /** Denormalised order stats, updated when orders change. */
    totalSpent: { type: Number, default: 0 },
    ordersCount: { type: Number, default: 0 },
    hasSubscription: { type: Boolean, default: false },
    lastActiveAt: { type: Date, default: null },
    cart: { type: cartSchema, required: true, default: () => ({}) },
    passwordResetToken: { type: String, default: '' },
    passwordResetExpires: { type: Date, default: null },
    /** Pending email change — proved by a code sent to the NEW address. */
    pendingEmail: { type: String, default: '' },
    pendingEmailCodeHash: { type: String, default: '' },
    pendingEmailExpires: { type: Date, default: null },
  },
  { timestamps: true },
);

customerSchema.index({ name: 'text' });

export type CustomerDoc = InferSchemaType<typeof customerSchema>;
export const Customer = model('Customer', customerSchema);
