import type { Request, Response, NextFunction } from 'express';
import { requireAdmin, requirePermission } from './adminAuth';

/** Authenticate the backend-issued admin JWT, then apply a granular gate. */
export const requireAdminPermission =
  (permission: string) => (req: Request, res: Response, next: NextFunction) => {
    requireAdmin(req, res, (err?: unknown) => {
      if (err) return next(err);
      requirePermission(permission)(req, res, next);
    });
  };
