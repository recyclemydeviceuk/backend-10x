import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAdminPermission } from '../../middleware/adminPermission';
import { requireAdmin } from '../../middleware/adminAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { ApiError } from '../../utils/ApiError';
import { getAdminProfile } from '../../models/AdminProfile';
import { AdminUser } from '../../models/AdminUser';
import { deleteMedia, uploadMedia } from '../../services/s3';
import { env } from '../../config/env';
import { hashPassword, isStrongPassword, verifyPassword } from '../../utils/password';

export const adminProfileRouter = Router();

const editableProfile = async (adminId: string) => {
  if (adminId === 'primary') return getAdminProfile();
  const member = await AdminUser.findById(adminId);
  if (!member) throw ApiError.notFound('Admin profile not found.');
  return member;
};

const profileView = async (adminId: string) => {
  const profile = await editableProfile(adminId);
  return {
    name: profile.name,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
    readNotificationIds: profile.readNotificationIds,
    preferences: profile.preferences,
  };
};

adminProfileRouter.get('/', requireAdminPermission('settings.view'), asyncHandler(async (_req, res) => {
  res.json({ ok: true, profile: await profileView(_req.admin!.id) });
}));

/**
 * Self-service password change — every team member owns their own password.
 * The Super Admin's password lives in the server's .env file, so there is
 * nothing here for the primary account to change.
 */
adminProfileRouter.post(
  '/password',
  // Any signed-in member may change their own password — owning your own
  // password is not a granted permission.
  requireAdmin,
  validateBody(z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().refine(isStrongPassword, 'Use 12+ characters with uppercase, lowercase, number, and symbol.'),
  })),
  asyncHandler(async (req, res) => {
    if (req.admin!.id === 'primary') {
      throw ApiError.badRequest("The Super Admin password is configured in the server's .env file and cannot change here.");
    }
    const member = await AdminUser.findById(req.admin!.id);
    if (!member) throw ApiError.notFound('Admin profile not found.');
    if (!(await verifyPassword(req.body.currentPassword, member.passwordHash))) {
      throw ApiError.badRequest('Your current password is not right.');
    }
    member.passwordHash = await hashPassword(req.body.newPassword);
    await member.save();
    res.json({ ok: true, message: 'Password changed.' });
  }),
);

adminProfileRouter.patch(
  '/',
  requireAdminPermission('settings.view'),
  validateBody(z.object({
    name: z.string().trim().min(2).max(80).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    readNotificationIds: z.array(z.string().min(1)).max(300).optional(),
    preferences: z.object({
      fontScale: z.number().int().min(90).max(120).optional(),
      density: z.enum(['comfortable', 'compact']).optional(),
      sidebarCollapsed: z.boolean().optional(),
      reduceMotion: z.boolean().optional(),
    }).optional(),
  })),
  asyncHandler(async (req, res) => {
    const profile = await editableProfile(req.admin!.id);
    if (req.body.name !== undefined) profile.name = req.body.name;
    // The owner account's email is fixed in the server's .env — only the
    // display name is editable. Team members may change their own email.
    if (req.body.email !== undefined && req.admin!.id === 'primary' && req.body.email !== env.adminEmail) {
      throw ApiError.badRequest("The Super Admin email is configured in the server's .env file and cannot change here.");
    }
    if (req.body.email !== undefined) profile.email = req.body.email;
    if (req.body.readNotificationIds !== undefined) profile.readNotificationIds = req.body.readNotificationIds;
    if (req.body.preferences && profile.preferences) Object.assign(profile.preferences, req.body.preferences);
    await profile.save();
    res.json({ ok: true, message: 'Admin preferences saved.', profile: await profileView(req.admin!.id) });
  }),
);

const photo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

adminProfileRouter.post(
  '/photo',
  requireAdminPermission('settings.view'),
  photo.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Choose a profile photo.');
    const profile = await editableProfile(req.admin!.id);
    const previous = profile.avatarUrl;
    profile.avatarUrl = await uploadMedia(req.file, 'profiles');
    await profile.save();
    if (previous) void deleteMedia(previous);
    res.status(201).json({ ok: true, message: 'Profile photo updated.', profile: await profileView(req.admin!.id) });
  }),
);

adminProfileRouter.delete('/photo', requireAdminPermission('settings.view'), asyncHandler(async (req, res) => {
  const profile = await editableProfile(req.admin!.id);
  const previous = profile.avatarUrl;
  profile.avatarUrl = '';
  await profile.save();
  if (previous) void deleteMedia(previous);
  res.json({ ok: true, message: 'Profile photo removed.', profile: await profileView(req.admin!.id) });
}));
