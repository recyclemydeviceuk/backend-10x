import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { signAdminToken } from '../../utils/jwt';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requireAdmin } from '../../middleware/adminAuth';
import { ApiError } from '../../utils/ApiError';
import crypto from 'crypto';
import { env } from '../../config/env';
import { getAdminProfile } from '../../models/AdminProfile';
import { AdminUser } from '../../models/AdminUser';
import { Role } from '../../models/Role';
import { verifyPassword } from '../../utils/password';

export const adminAuthRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

function secureEqual(input: string, expected: string): boolean {
  const left = crypto.createHmac('sha256', env.adminJwtSecret).update(input).digest();
  const right = crypto.createHmac('sha256', env.adminJwtSecret).update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

const primaryView = (profile: Awaited<ReturnType<typeof getAdminProfile>>) => ({
  id: 'primary',
  name: profile.name,
  email: profile.email,
  avatarUrl: profile.avatarUrl,
  readNotificationIds: profile.readNotificationIds,
  preferences: profile.preferences,
  role: { id: 'super-admin', name: 'Super Admin' },
  permissions: ['*'],
});

const contextView = (admin: NonNullable<Express.Request['admin']>) => ({
  id: admin.id,
  name: admin.name,
  email: admin.email,
  avatarUrl: admin.avatarUrl,
  readNotificationIds: admin.readNotificationIds,
  preferences: admin.preferences,
  role: { id: admin.roleId, name: admin.roleName },
  permissions: admin.permissions,
});

adminAuthRouter.post(
  '/login',
  loginLimiter,
  validateBody(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (secureEqual(email, env.adminEmail) && secureEqual(password, env.adminPassword)) {
      const profile = await getAdminProfile();
      return res.json({ ok: true, token: signAdminToken('primary'), user: primaryView(profile) });
    }

    const member = await AdminUser.findOne({ email });
    if (!member?.active || !await verifyPassword(password, member.passwordHash)) {
      throw ApiError.unauthorized('That email and password don’t match.');
    }
    const role = await Role.findById(member.roleId);
    if (!role) throw ApiError.unauthorized('This team account has no active role.');
    member.lastLoginAt = new Date();
    await member.save();
    res.json({
      ok: true,
      token: signAdminToken(`team:${member.id}`),
      user: {
        id: member.id,
        name: member.name,
        email: member.email,
        avatarUrl: member.avatarUrl,
        readNotificationIds: member.readNotificationIds,
        preferences: member.preferences,
        role: { id: role.id, name: role.name },
        permissions: role.permissions,
      },
    });
  }),
);

adminAuthRouter.get(
  '/me',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({ ok: true, user: contextView(req.admin!) });
  }),
);
