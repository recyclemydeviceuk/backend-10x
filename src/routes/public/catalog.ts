import { Router } from 'express';
import { z } from 'zod';
import { Product } from '../../models/Product';
import { getSettings } from '../../models/Setting';
import { Coupon } from '../../models/Coupon';
import { discountFor, resolveCoupon } from '../../services/coupons';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { ApiError } from '../../utils/ApiError';
import { optionalCustomer } from '../../middleware/customerAuth';
import { quoteDelivery } from '../../services/delivery';

export const catalogRouter = Router();

const productView = (p: InstanceType<typeof Product>) => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  tagline: p.tagline,
  description: p.description,
  images: p.images,
  imagesDark: p.imagesDark,
  video: p.video,
  seo: p.seo,
  storefront: p.storefront,
  tiers: p.tiers
    .filter((t) => t.available)
    .map((t) => ({
      id: t.id,
      name: t.name,
      packets: t.packets,
      oneTimePrice: t.oneTimePrice,
      subscribePrice: t.subscribePrice,
      inStock: t.stock > 0,
      stock: t.stock,
      lowStock: t.stock > 0 && t.stock <= t.lowStockAt,
    })),
});

catalogRouter.get(
  '/products',
  asyncHandler(async (_req, res) => {
    const products = await Product.find({ status: 'active' }).sort({ createdAt: 1 });
    res.json({ ok: true, products: products.map(productView) });
  }),
);

catalogRouter.get(
  '/products/:slug',
  asyncHandler(async (req, res) => {
    const product = await Product.findOne({ slug: req.params.slug, status: 'active' });
    if (!product) throw ApiError.notFound('Product not found.');
    res.json({ ok: true, product: productView(product) });
  }),
);

/**
 * Store rules the storefront needs to show an honest total BEFORE checkout —
 * the shipping threshold especially. Hard-coding it in the browser is how a
 * cart ends up promising free delivery the server then charges for.
 */
catalogRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    const s = await getSettings();
    res.json({
      ok: true,
      settings: {
        storeName: s.store.name,
        supportEmail: s.store.supportEmail,
        supportPhone: s.store.supportPhone,
        comingSoonMode: s.store.comingSoonMode,
        deliveryMode: s.store.deliveryMode,
        freeShippingOver: s.store.freeShippingOver,
        flatShipping: s.store.flatShipping,
        codEnabled: s.store.codEnabled,
        subscriptionIntervalDays: s.store.subscriptionIntervalDays,
      },
    });
  }),
);

/**
 * Codes worth putting in front of the customer, so nobody has to hunt for one
 * — a promo that can't be found is a promo that doesn't work.
 *
 * A coupon is promoted by giving it a description in the admin panel; that
 * description is the label shown on the chip. Codes with no description stay
 * private, which is what a targeted or single-use code needs.
 */
catalogRouter.get(
  '/coupons/featured',
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const coupons = await Coupon.find({
      active: true,
      description: { $nin: ['', null] },
      $and: [
        { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(3);

    res.json({
      ok: true,
      coupons: coupons
        .filter((c) => c.usageLimit == null || c.usedCount < c.usageLimit)
        .map((c) => ({
          code: c.code,
          label: c.description,
          minOrder: c.minOrderValue,
        })),
    });
  }),
);

/* ------------------------------------------------------ delivery quote */
// What the cart shows for "Delivery". Same function the checkout charges
// with, so the two can never disagree.
catalogRouter.post(
  '/delivery/quote',
  validateBody(
    z.object({
      amount: z.number().min(0),
      quantity: z.number().int().min(1).max(99).default(1),
      pincode: z.string().trim().regex(/^\d{6}$/).optional(),
      cod: z.boolean().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, quote: await quoteDelivery(req.body) });
  }),
);

/* ------------------------------------------------- coupon pre-validation */
catalogRouter.post(
  '/coupons/validate',
  optionalCustomer,
  validateBody(z.object({ code: z.string().trim().toUpperCase().min(1), subtotal: z.number().min(0) })),
  asyncHandler(async (req, res) => {
    const { code, subtotal } = req.body;
    const { coupon, discount } = await resolveCoupon(code, subtotal, req.customer?.id);
    res.json({
      ok: true,
      coupon: {
        code: coupon.code,
        type: coupon.type,
        value: coupon.value,
        description: coupon.description,
      },
      discount,
    });
  }),
);

/**
 * Early-access signup from the coming-soon page. Idempotent per email; the
 * honeypot swallows bots without telling them; rate limit keeps floods out.
 */
import rateLimit from 'express-rate-limit';
import { Signup } from '../../models/Signup';
import { logEvent } from '../../models/Event';

const signupLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

catalogRouter.post(
  '/signups',
  signupLimiter,
  validateBody(
    z.object({
      email: z.string().trim().toLowerCase().email('That email doesn\u2019t look right.'),
      /** Honeypot — a real person never fills a field they can't see. */
      company: z.string().optional().default(''),
    }),
  ),
  asyncHandler(async (req, res) => {
    if (req.body.company) return res.status(201).json({ ok: true });
    const existing = await Signup.findOne({ email: req.body.email });
    if (!existing) {
      await Signup.create({ email: req.body.email, source: 'coming-soon' });
      await logEvent('customer', 'Early-access signup', req.body.email, '/settings?tab=coming-soon');
    }
    res.status(201).json({ ok: true });
  }),
);
