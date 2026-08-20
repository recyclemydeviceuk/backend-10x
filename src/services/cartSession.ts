import crypto from 'crypto';
import type { Request, Response } from 'express';
import { CartSession } from '../models/CartSession';
import { SESSION_COOKIE_OPTIONS } from '../utils/sessionCookie';

export const CART_COOKIE = '10x_cart_session';
export const CART_EXPIRES_MS = 30 * 86400_000;

export function cookieValue(req: Request, name: string): string {
  for (const item of String(req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function ensureCartSession(req: Request, res: Response): string {
  const existing = cookieValue(req, CART_COOKIE);
  if (existing) return existing;
  const id = crypto.randomBytes(32).toString('base64url');
  res.cookie(CART_COOKIE, id, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: CART_EXPIRES_MS,
  });
  return id;
}

/** Attach the browser's anonymous cart to the account that just signed in. */
export async function claimCartForCustomer(req: Request, customerId: string): Promise<void> {
  const sessionId = cookieValue(req, CART_COOKIE);
  if (!sessionId) return;
  await CartSession.updateOne(
    { sessionId },
    { $set: { customerId, expiresAt: new Date(Date.now() + CART_EXPIRES_MS) } },
  );
}

/**
 * Resolve the current browser cart. If a signed-in customer arrives on a new
 * device with an empty cart, copy their latest saved cart into this session.
 */
export async function cartForRequest(req: Request, res: Response, customerId: string | null) {
  const sessionId = ensureCartSession(req, res);
  let cart = await CartSession.findOne({ sessionId });

  if (!customerId) return cart;

  if (cart?.line) {
    if (String(cart.customerId ?? '') !== customerId) {
      cart.customerId = customerId as never;
      cart.expiresAt = new Date(Date.now() + CART_EXPIRES_MS);
      await cart.save();
    }
    return cart;
  }

  const saved = await CartSession.findOne({
    customerId,
    line: { $ne: null },
    sessionId: { $ne: sessionId },
  }).sort({ updatedAt: -1 });

  if (saved) {
    cart = await CartSession.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          customerId,
          line: saved.line,
          couponCode: saved.couponCode,
          expiresAt: new Date(Date.now() + CART_EXPIRES_MS),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } else if (cart) {
    cart.customerId = customerId as never;
    cart.expiresAt = new Date(Date.now() + CART_EXPIRES_MS);
    await cart.save();
  }

  return cart;
}

export async function clearCartForRequest(req: Request, res?: Response): Promise<void> {
  const sessionId = cookieValue(req, CART_COOKIE);
  if (sessionId) await CartSession.deleteOne({ sessionId });
  res?.clearCookie(CART_COOKIE, SESSION_COOKIE_OPTIONS);
}
