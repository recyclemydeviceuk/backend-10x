import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export type CustomerToken = { sub: string; kind: 'customer' };
export type AdminToken = { sub: string; kind: 'admin' };

const CUSTOMER_TTL = '30d';
const ADMIN_TTL = '7d';

export function signCustomerToken(customerId: string): string {
  return jwt.sign({ kind: 'customer' } as object, env.jwtSecret, {
    subject: customerId,
    expiresIn: CUSTOMER_TTL,
  });
}

export function signAdminToken(userId: string): string {
  return jwt.sign({ kind: 'admin' } as object, env.adminJwtSecret, {
    subject: userId,
    expiresIn: ADMIN_TTL,
  });
}

export function verifyCustomerToken(token: string): CustomerToken | null {
  try {
    const payload = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload;
    if (payload.kind !== 'customer' || !payload.sub) return null;
    return { sub: payload.sub, kind: 'customer' };
  } catch {
    return null;
  }
}

export function verifyAdminToken(token: string): AdminToken | null {
  try {
    const payload = jwt.verify(token, env.adminJwtSecret) as jwt.JwtPayload;
    if (payload.kind !== 'admin' || !payload.sub) return null;
    return { sub: payload.sub, kind: 'admin' };
  } catch {
    return null;
  }
}
