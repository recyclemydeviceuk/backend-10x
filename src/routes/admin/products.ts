import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Product } from '../../models/Product';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { ApiError } from '../../utils/ApiError';
import { uploadMedia } from '../../services/s3';

export const adminProductsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const tierSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1),
  packets: z.number().int().min(1),
  oneTimePrice: z.number().min(0),
  subscribePrice: z.number().min(0),
  stock: z.number().int().min(0),
  lowStockAt: z.number().int().min(0),
  available: z.boolean(),
});

const productSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, 'Slug can only use lowercase letters, numbers and dashes.'),
  name: z.string().trim().min(2),
  tagline: z.string().trim().default(''),
  description: z.string().trim().default(''),
  images: z.array(z.string().url()).default([]),
  imagesDark: z.array(z.string().url()).default([]),
  video: z.string().default(''),
  tiers: z.array(tierSchema).min(1, 'A product needs at least one pack.'),
  status: z.enum(['active', 'draft', 'archived']).default('draft'),
  storefront: z
    .object({
      kicker: z.string().default(''),
      subscriptionNote: z.string().default('Skip or cancel anytime, no login required.'),
      priceNote: z.string().default('One-time purchase · incl. GST'),
      subscribePriceNote: z.string().default('Every 4 weeks · skip or cancel anytime · incl. GST'),
      ctaLabel: z.string().default('Add to Cart'),
      perfectFor: z.string().default(''),
      benefits: z.array(z.string().trim().min(1)).default([]),
    })
    .optional(),
  seo: z.object({ title: z.string().default(''), description: z.string().default('') }).default({ title: '', description: '' }),
});

adminProductsRouter.get(
  '/',
  requirePermission('products.view'),
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = {};
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { slug: rx }];
    }
    if (['active', 'draft', 'archived'].includes(String(req.query.status))) filter.status = req.query.status;
    const products = await Product.find(filter).sort({ createdAt: 1 });
    res.json({ ok: true, products });
  }),
);

adminProductsRouter.get(
  '/:id',
  requirePermission('products.view'),
  asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound('Product not found.');
    res.json({ ok: true, product });
  }),
);

adminProductsRouter.post(
  '/',
  requirePermission('products.create'),
  validateBody(productSchema),
  asyncHandler(async (req, res) => {
    if (await Product.findOne({ slug: req.body.slug })) throw ApiError.conflict('That slug is taken.');
    const product = await Product.create(req.body);
    res.status(201).json({ ok: true, product });
  }),
);

adminProductsRouter.patch(
  '/:id',
  requirePermission('products.edit'),
  validateBody(productSchema.partial()),
  asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound('Product not found.');
    if (req.body.slug && req.body.slug !== product.slug) {
      if (await Product.findOne({ slug: req.body.slug })) throw ApiError.conflict('That slug is taken.');
    }
    Object.assign(product, req.body);
    await product.save();
    res.json({ ok: true, product });
  }),
);

adminProductsRouter.delete(
  '/:id',
  requirePermission('products.delete'),
  asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound('Product not found.');
    await product.deleteOne();
    res.json({ ok: true, message: `${product.name} deleted.` });
  }),
);

/** Media upload → S3 (spec-validated in services/s3). */
adminProductsRouter.post(
  '/media',
  requirePermission('products.media'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('No file received.');
    const url = await uploadMedia(req.file, 'products');
    res.status(201).json({ ok: true, asset: { url } });
  }),
);
