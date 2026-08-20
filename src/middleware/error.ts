import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ ok: false, message: 'Route not found.' });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ ok: false, message: err.message });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const path = first?.path.join('.') ?? '';
    return res.status(400).json({
      ok: false,
      message: `${path ? `${path}: ` : ''}${first?.message ?? 'Invalid input.'}`,
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  console.error('[error]', err);
  return res.status(500).json({
    ok: false,
    message: env.isProd ? 'Something went wrong.' : err instanceof Error ? err.message : 'Something went wrong.',
  });
}
