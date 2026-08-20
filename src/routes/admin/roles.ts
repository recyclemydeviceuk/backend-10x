import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { Role, ensureDefaultRoles } from '../../models/Role';
import { AdminUser } from '../../models/AdminUser';
import { requirePermission } from '../../middleware/adminAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { ApiError } from '../../utils/ApiError';
import { ALL_PERMISSION_IDS, expandPermissions, roleHas } from '../../auth/permissions';

export const adminRolesRouter = Router();

const roleInput = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(240).default(''),
  permissions: z.array(z.string().trim().min(1)).max(200),
});

const roleView = (role: any) => ({
  id: String(role._id),
  name: role.name,
  description: role.description,
  permissions: role.permissions.includes('*') ? ['*'] : [...expandPermissions(role.permissions)],
  system: role.system,
});

function assertGrantable(adminPermissions: string[], requested: string[]) {
  if (adminPermissions.includes('*')) return;
  if (requested.includes('*') || [...expandPermissions(requested)].some((permission) => !roleHas(adminPermissions, permission))) {
    throw ApiError.forbidden('You cannot grant permissions you do not have.');
  }
}

/**
 * A custom role may hold ANY subset of permissions — except all of them.
 *
 * A role with every permission IS Super Admin under another name, and Super
 * Admin is deliberately the one role that is built in, fixed, and impossible
 * to hand out by accident. Two ways someone could try to sneak one in:
 * the literal '*' wildcard, or ticking every box in the catalogue — both are
 * refused with the same explanation.
 */
function assertNotEffectivelySuperAdmin(requested: string[]) {
  if (requested.includes('*')) {
    throw ApiError.badRequest(
      'Custom roles cannot use the all-access wildcard — that is what the built-in Super Admin role is. Leave at least one permission off.',
    );
  }
  const expanded = expandPermissions(requested);
  if (ALL_PERMISSION_IDS.every((permission) => expanded.has(permission))) {
    throw ApiError.badRequest(
      'This role would hold every permission, which makes it a second Super Admin. Assign the built-in Super Admin role instead, or leave at least one permission off.',
    );
  }
}

adminRolesRouter.get('/', requirePermission('roles.view'), asyncHandler(async (_req, res) => {
  await ensureDefaultRoles();
  const [roles, counts] = await Promise.all([
    Role.find().sort({ system: -1, name: 1 }).lean(),
    AdminUser.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$roleId', count: { $sum: 1 } } }]),
  ]);
  const memberCounts = Object.fromEntries(counts.map((item) => [item._id, item.count]));
  // Super Admin never appears in the roles UI: it is not a role anyone can
  // hold, edit or assign — it is the .env-configured owner account only.
  const visible = roles.filter((role) => String(role._id) !== 'super-admin');
  res.json({ ok: true, roles: visible.map((role) => ({ ...roleView(role), memberCount: memberCounts[String(role._id)] ?? 0 })) });
}));

adminRolesRouter.post(
  '/',
  requirePermission('roles.create'),
  validateBody(roleInput),
  asyncHandler(async (req, res) => {
    assertNotEffectivelySuperAdmin(req.body.permissions);
    assertGrantable(req.admin!.permissions, req.body.permissions);
    if (await Role.exists({ name: new RegExp(`^${req.body.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })) {
      throw ApiError.conflict('A role with that name already exists.');
    }
    const role = await Role.create({ _id: `role-${crypto.randomUUID()}`, ...req.body, system: false });
    res.status(201).json({ ok: true, message: 'Role created.', role: roleView(role) });
  }),
);

adminRolesRouter.patch(
  '/:id',
  requirePermission('roles.edit'),
  validateBody(roleInput.partial()),
  asyncHandler(async (req, res) => {
    const role = await Role.findById(req.params.id);
    if (!role) throw ApiError.notFound('Role not found.');
    if (role._id === 'super-admin') throw ApiError.forbidden('The Super Admin role is fixed.');
    if (req.body.permissions) {
      assertNotEffectivelySuperAdmin(req.body.permissions);
      assertGrantable(req.admin!.permissions, req.body.permissions);
    }
    Object.assign(role, req.body);
    await role.save();
    res.json({ ok: true, message: 'Role updated.', role: roleView(role) });
  }),
);

adminRolesRouter.delete('/:id', requirePermission('roles.delete'), asyncHandler(async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) throw ApiError.notFound('Role not found.');
  if (role.system) throw ApiError.forbidden('System roles cannot be deleted.');
  if (await AdminUser.exists({ roleId: role._id })) throw ApiError.conflict('Move this role’s team members before deleting it.');
  await role.deleteOne();
  res.json({ ok: true, message: 'Role deleted.' });
}));
