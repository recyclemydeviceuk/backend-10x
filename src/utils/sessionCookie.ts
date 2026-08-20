import type { CookieOptions } from 'express';
import { env } from '../config/env';

/**
 * Shared attributes for browser sessions issued by the API.
 *
 * Production currently serves the storefront and API from different sites,
 * so the browser requires SameSite=None together with Secure. Local HTTP
 * development stays Lax and non-secure.
 */
export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: env.isProd,
  sameSite: env.isProd ? 'none' : 'lax',
  path: '/',
};
