import { Schema, model, type InferSchemaType } from 'mongoose';

const tierSchema = new Schema(
  {
    name: { type: String, required: true },
    packets: { type: Number, required: true, min: 1 },
    oneTimePrice: { type: Number, required: true, min: 0 },
    subscribePrice: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    lowStockAt: { type: Number, default: 10, min: 0 },
    available: { type: Boolean, default: true },
  },
  { _id: true },
);

// Product-page hero copy — the storefront renders these fields directly.
const storefrontSchema = new Schema(
  {
    kicker: { type: String, default: '' },
    subscriptionNote: { type: String, default: 'Skip or cancel anytime, no login required.' },
    priceNote: { type: String, default: 'One-time purchase · incl. GST' },
    subscribePriceNote: { type: String, default: 'Every 4 weeks · skip or cancel anytime · incl. GST' },
    ctaLabel: { type: String, default: 'Add to Cart' },
    perfectFor: { type: String, default: '' },
    benefits: { type: [String], default: [] },
  },
  { _id: false },
);

const seoSchema = new Schema(
  {
    title: { type: String, default: '' },
    description: { type: String, default: '' },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    tagline: { type: String, default: '' },
    description: { type: String, default: '' },
    /** Photography for the light look — the default set. */
    images: { type: [String], default: [] },
    /**
     * Photography for the dark and black looks. Optional: an empty list falls
     * back to `images`, so a product is never left without a photo just
     * because a second set hasn't been shot yet.
     */
    imagesDark: { type: [String], default: [] },
    video: { type: String, default: '' },
    tiers: { type: [tierSchema], default: [] },
    status: { type: String, enum: ['active', 'draft', 'archived'], default: 'draft' },
    seo: { type: seoSchema, required: true, default: () => ({}) },
    storefront: { type: storefrontSchema, required: true, default: () => ({}) },
  },
  { timestamps: true },
);

export type ProductDoc = InferSchemaType<typeof productSchema>;
export const Product = model('Product', productSchema);
