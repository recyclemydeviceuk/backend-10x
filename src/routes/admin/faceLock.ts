import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

import { env } from '../../config/env';
import { AdminUser } from '../../models/AdminUser';
import { FaceLock } from '../../models/FaceLock';
import { Role } from '../../models/Role';
import { requireAdmin } from '../../middleware/adminAuth';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { signAdminToken } from '../../utils/jwt';

// =========================================================
// Face lock — webcam sign-in for the admin panel.
//
// The browser reduces the camera frame to a 128-number face
// descriptor (face-api.js, running locally); only that vector
// travels. Matching happens HERE, server-side, by Euclidean
// distance against the enrolled poses — the enrolled faces
// never leave the database. Email + password stays available;
// this is a second door, not a replacement.
// =========================================================

export const adminFaceLockRouter = Router();

/**
 * face-api's own recommended threshold: same person under different lighting
 * lands 0.3–0.55, strangers 0.6+. (0.5 rejected real owners on bad lighting.)
 */
const MATCH_THRESHOLD = 0.6;

// A sign-in click makes a handful of paced attempts, so the window must hold
// several clicks — 30 tries of a 128-float vector is still no brute force.
const faceLoginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Too many face attempts — wait a few minutes or sign in with your password.' },
});

const descriptor = z.array(z.number().finite().min(-1).max(1)).length(128);

function distance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/* ------------------------------------------------- manage (signed in) */

adminFaceLockRouter.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const lock = await FaceLock.findOne({ adminId: req.admin!.id });
  res.json({
    ok: true,
    enrolled: Boolean(lock),
    poses: lock?.descriptors.length ?? 0,
    updatedAt: lock?.updatedAt ?? null,
    lastUsedAt: lock?.lastUsedAt ?? null,
  });
}));

adminFaceLockRouter.post(
  '/enroll',
  requireAdmin,
  validateBody(z.object({ descriptors: z.array(descriptor).min(1).max(5) })),
  asyncHandler(async (req, res) => {
    await FaceLock.findOneAndUpdate(
      { adminId: req.admin!.id },
      { adminId: req.admin!.id, descriptors: req.body.descriptors },
      { upsert: true },
    );
    res.status(201).json({ ok: true, message: 'Face lock set. You can now sign in with your face.' });
  }),
);

adminFaceLockRouter.delete('/', requireAdmin, asyncHandler(async (req, res) => {
  const removed = await FaceLock.findOneAndDelete({ adminId: req.admin!.id });
  if (!removed) throw ApiError.notFound('No face lock is set on this account.');
  res.json({ ok: true, message: 'Face lock removed. Sign-in is email and password only again.' });
}));

/* --------------------------------------------------- sign in (public) */

adminFaceLockRouter.post(
  '/login',
  faceLoginLimiter,
  validateBody(z.object({ email: z.string().trim().toLowerCase().email(), descriptor })),
  asyncHandler(async (req, res) => {
    // One identical failure message throughout — this endpoint must not
    // reveal which emails have admin accounts or face locks.
    const fail = () => ApiError.unauthorized('Face not recognised. Use your email and password.');

    let adminId: string | null = null;
    if (req.body.email === env.adminEmail) {
      adminId = 'primary';
    } else {
      const member = await AdminUser.findOne({ email: req.body.email, active: true });
      adminId = member ? member.id : null;
    }
    if (!adminId) throw fail();

    const lock = await FaceLock.findOne({ adminId });
    if (!lock || lock.descriptors.length === 0) throw fail();

    const stored = lock.toObject().descriptors as unknown as number[][];
    const best = Math.min(...stored.map((pose) => distance(pose, req.body.descriptor)));
    if (best > MATCH_THRESHOLD) throw fail();

    lock.lastUsedAt = new Date();
    await lock.save();

    // Same session as a password sign-in — the face changes the front door,
    // not what's behind it.
    if (adminId === 'primary') {
      return res.json({ ok: true, token: signAdminToken('primary') });
    }
    const member = await AdminUser.findById(adminId);
    if (!member?.active) throw fail();
    const role = await Role.findById(member.roleId);
    if (!role) throw fail();
    member.lastLoginAt = new Date();
    await member.save();
    res.json({ ok: true, token: signAdminToken(`team:${member.id}`) });
  }),
);
