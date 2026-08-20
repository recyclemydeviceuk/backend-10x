import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { requireAdminPermission } from '../../middleware/adminPermission';
import { uploadMedia } from '../../services/s3';

// =========================================================
// Product media → S3.
//
// Its own router (rather than a route inside /admin/products)
// lets the panel forward the authenticated browser upload here,
// and the file ends up on S3 with an ABSOLUTE url.
//
// That matters because the storefront is a different app on a
// different origin: a path like /uploads/x.png written to the
// panel's own disk resolves against the storefront's domain and
// 404s, so the product photo never appears on the site.
// =========================================================

export const adminMediaRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // The per-type limits live in services/s3; this is the outer ceiling.
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

adminMediaRouter.post(
  '/',
  requireAdminPermission('products.media'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('No file received.');
    const url = await uploadMedia(req.file, 'products');
    res.status(201).json({ ok: true, asset: { url } });
  }),
);
