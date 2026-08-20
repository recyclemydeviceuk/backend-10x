import type { Request, Response } from 'express';
import { env } from '../config/env';

export const CUSTOMER_COOKIE = '10x_customer_session';

export function customerTokenFromRequest(req: Request): string {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const cookies = String(req.headers.cookie ?? '').split(';');
  for (const item of cookies) {
    const [name, ...rest] = item.trim().split('=');
    if (name === CUSTOMER_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function setCustomerSession(res: Response, token: string): void {
  res.cookie(CUSTOMER_COOKIE, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax',
    maxAge: 30 * 86400_000,
    path: '/',
  });
}

export function clearCustomerSession(res: Response): void {
  res.clearCookie(CUSTOMER_COOKIE, { httpOnly: true, secure: env.isProd, sameSite: 'lax', path: '/' });
}
