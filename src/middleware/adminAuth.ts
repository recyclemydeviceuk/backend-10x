import type { Request, Response, NextFunction } from 'express';
import { verifyAdminToken } from '../utils/jwt';
import { roleHas } from '../auth/permissions';
import { ApiError } from '../utils/ApiError';
import { getAdminProfile } from '../models/AdminProfile';
import { AdminUser } from '../models/AdminUser';
import { Role } from '../models/Role';
import { env } from '../config/env';

export type AdminContext = {
  id: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  avatarUrl: string;
  readNotificationIds: string[];
  preferences: {
    fontScale: number;
    density: 'comfortable' | 'compact';
    sidebarCollapsed: boolean;
    reduceMotion: boolean;
  };
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminContext;
    }
  }
}

function bearer(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

const defaultPreferences = {
  fontScale: 100,
  density: 'comfortable' as const,
  sidebarCollapsed: false,
  reduceMotion: false,
};

/** Resolve either the environment-backed owner or a database-backed team account. */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = bearer(req);
    const payload = token ? verifyAdminToken(token) : null;
    if (!payload) throw ApiError.unauthorized();
    if (payload.sub === 'primary') {
      const profile = await getAdminProfile();
      req.admin = {
        id: 'primary',
        name: env.adminName,
        email: env.adminEmail,
        roleId: 'super-admin',
        roleName: 'Super Admin',
        permissions: ['*'],
        avatarUrl: profile.avatarUrl,
        readNotificationIds: profile.readNotificationIds,
        preferences: profile.preferences ?? defaultPreferences,
      };
    } else if (payload.sub.startsWith('team:')) {
      const member = await AdminUser.findById(payload.sub.slice(5));
      if (!member?.active) throw ApiError.unauthorized('This team account is inactive.');
      const role = await Role.findById(member.roleId);
      if (!role) throw ApiError.unauthorized('This team account has no active role.');
      req.admin = {
        id: member.id,
        name: member.name,
        email: member.email,
        roleId: role.id,
        roleName: role.name,
        permissions: role.permissions,
        avatarUrl: member.avatarUrl,
        readNotificationIds: member.readNotificationIds,
        preferences: member.preferences ?? defaultPreferences,
      };
    } else {
      throw ApiError.unauthorized();
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Per-route granular gate: router.post('/x', requirePermission('orders.status'), …) */
export const requirePermission =
  (permission: string) => (req: Request, _res: Response, next: NextFunction) => {
    if (!req.admin) return next(ApiError.unauthorized());
    if (!roleHas(req.admin.permissions, permission)) {
      return next(ApiError.forbidden(`Your role does not allow this (${permission}).`));
    }
    next();
  };
