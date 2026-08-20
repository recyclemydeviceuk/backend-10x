import { Router } from 'express';
import { z } from 'zod';
import { AdminUser } from '../../models/AdminUser';
import { Role, ensureDefaultRoles } from '../../models/Role';
import { requirePermission } from '../../middleware/adminAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { ApiError } from '../../utils/ApiError';
import { randomInt } from 'node:crypto';
import { hashPassword } from '../../utils/password';
import { emails } from '../../services/emails';
import { env } from '../../config/env';
import { getAdminProfile } from '../../models/AdminProfile';
import { expandPermissions, roleHas } from '../../auth/permissions';

export const adminTeamRouter = Router();

const createInput = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  roleId: z.string().min(1),
});

/** 16 chars with every class present — strong by the same rule sign-in enforces. */
function generateTempPassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*?'];
  const all = sets.join('');
  const chars = sets.map((set) => set[randomInt(set.length)]);
  while (chars.length < 16) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const memberView = (member: any, role?: any) => ({
  id: String(member._id),
  name: member.name,
  email: member.email,
  roleId: member.roleId,
  roleName: role?.name ?? 'Unknown role',
  active: member.active,
  protected: false,
  avatarUrl: member.avatarUrl ?? '',
  createdAt: member.createdAt,
  lastLoginAt: member.lastLoginAt,
});

function assertRoleAssignable(adminPermissions: string[], roleId: string, rolePermissions: string[]) {
  // Super Admin is never assignable — to anyone, by anyone. It exists only as
  // the account configured in the server's .env file.
  if (roleId === 'super-admin' || rolePermissions.includes('*')) {
    throw ApiError.forbidden('Super Admin cannot be assigned. It is configured only in the server\'s .env file.');
  }
  if (adminPermissions.includes('*')) return;
  if ([...expandPermissions(rolePermissions)].some((permission) => !roleHas(adminPermissions, permission))) {
    throw ApiError.forbidden('You cannot assign a role with permissions you do not have.');
  }
}

adminTeamRouter.get('/', requirePermission('team.view'), asyncHandler(async (_req, res) => {
  await ensureDefaultRoles();
  const [members, roles, primary] = await Promise.all([
    AdminUser.find().sort({ createdAt: 1 }).lean(),
    Role.find().lean(),
    getAdminProfile(),
  ]);
  const byId = new Map(roles.map((role) => [String(role._id), role]));
  res.json({
    ok: true,
    members: [
      {
        id: 'primary',
        name: primary.name,
        email: env.adminEmail,
        roleId: 'super-admin',
        roleName: 'Super Admin',
        active: true,
        protected: true,
        avatarUrl: primary.avatarUrl,
        createdAt: null,
        lastLoginAt: null,
      },
      ...members.map((member) => memberView(member, byId.get(member.roleId))),
    ],
    // The dropdown the panel builds from this list must never offer Super
    // Admin — it is not assignable from any UI.
    roles: roles.filter((role) => String(role._id) !== 'super-admin').map((role) => ({ id: String(role._id), name: role.name })),
  });
}));

adminTeamRouter.post(
  '/',
  requirePermission('team.invite'),
  validateBody(createInput),
  asyncHandler(async (req, res) => {
    if (req.body.email === env.adminEmail || await AdminUser.exists({ email: req.body.email })) {
      throw ApiError.conflict('That email already has an admin account.');
    }
    const role = await Role.findById(req.body.roleId);
    if (!role) throw ApiError.badRequest('Choose a valid role.');
    assertRoleAssignable(req.admin!.permissions, String(role._id), role.permissions);
    const tempPassword = generateTempPassword();
    const member = await AdminUser.create({
      name: req.body.name,
      email: req.body.email,
      roleId: role._id,
      passwordHash: await hashPassword(tempPassword),
      active: true,
    });
    const emailed = await emails.teamInvite({
      email: member.email,
      name: member.name,
      tempPassword,
      roleName: role.name,
    });
    res.status(201).json({
      ok: true,
      message: emailed
        ? `Invite emailed to ${member.email} with a temporary password.`
        : 'Account created, but the invite email could not be sent — hand this temporary password over once.',
      member: memberView(member, role),
      // Only exposed when the email failed; otherwise it travels by email alone.
      ...(emailed ? {} : { tempPassword }),
    });
  }),
);

adminTeamRouter.patch(
  '/:id',
  requirePermission('team.roles'),
  validateBody(z.object({
    name: z.string().trim().min(2).max(80).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    roleId: z.string().min(1).optional(),
  })),
  asyncHandler(async (req, res) => {
    const member = await AdminUser.findById(req.params.id);
    if (!member) throw ApiError.notFound('Team member not found.');
    if (req.body.email && (req.body.email === env.adminEmail || await AdminUser.exists({ email: req.body.email, _id: { $ne: member._id } }))) {
      throw ApiError.conflict('That email already has an admin account.');
    }
    if (req.body.roleId) {
      const role = await Role.findById(req.body.roleId);
      if (!role) throw ApiError.badRequest('Choose a valid role.');
      assertRoleAssignable(req.admin!.permissions, String(role._id), role.permissions);
    }
    Object.assign(member, req.body);
    await member.save();
    res.json({ ok: true, message: 'Team member updated.' });
  }),
);

adminTeamRouter.post(
  '/:id/password',
  requirePermission('team.password'),
  asyncHandler(async (req, res) => {
    const member = await AdminUser.findById(req.params.id);
    if (!member) throw ApiError.notFound('Team member not found.');
    const role = await Role.findById(member.roleId);
    const tempPassword = generateTempPassword();
    member.passwordHash = await hashPassword(tempPassword);
    await member.save();
    const emailed = await emails.teamInvite({
      email: member.email,
      name: member.name,
      tempPassword,
      roleName: role?.name ?? 'team member',
    });
    res.json({
      ok: true,
      message: emailed
        ? `A new temporary password was emailed to ${member.email}.`
        : 'Password reset, but the email could not be sent — hand this temporary password over once.',
      ...(emailed ? {} : { tempPassword }),
    });
  }),
);

adminTeamRouter.post('/:id/toggle', requirePermission('team.deactivate'), asyncHandler(async (req, res) => {
  const member = await AdminUser.findById(req.params.id);
  if (!member) throw ApiError.notFound('Team member not found.');
  member.active = !member.active;
  await member.save();
  res.json({ ok: true, message: member.active ? 'Account reactivated.' : 'Account deactivated.' });
}));

adminTeamRouter.delete('/:id', requirePermission('team.delete'), asyncHandler(async (req, res) => {
  const member = await AdminUser.findByIdAndDelete(req.params.id);
  if (!member) throw ApiError.notFound('Team member not found.');
  res.json({ ok: true, message: 'Team member deleted.' });
}));
