import crypto from 'crypto';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';

// Cashfree Payment Gateway — REST, api-version 2023-08-01. Credentials are
// Credentials are environment-only and never stored in MongoDB.
const creds = () => env.cashfree;

export async function cashfreeMode(): Promise<'production' | 'sandbox'> {
  return creds().env;
}

export async function isCashfreeConfigured(): Promise<boolean> {
  const { appId, secretKey } = creds();
  return Boolean(appId && secretKey);
}

async function cf<T>(path: string, init?: RequestInit): Promise<T> {
  const { env: mode, appId, secretKey } = creds();
  if (!appId || !secretKey) {
    throw ApiError.badRequest('Cashfree is not configured on the backend.');
  }
  const base = mode === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'x-client-id': appId,
      'x-client-secret': secretKey,
      'x-api-version': '2023-08-01',
      'content-type': 'application/json',
      accept: 'application/json',
      ...init?.headers,
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = (data.message as string) || `Cashfree error ${res.status}`;
    throw new ApiError(res.status >= 500 ? 502 : 400, message);
  }
  return data as T;
}

export type CashfreeOrder = {
  order_id: string;
  order_status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED' | string;
  payment_session_id?: string;
  order_amount: number;
};

/** Creates a PG order and returns the payment_session_id the storefront needs. */
/** Cashfree only accepts an https return_url; anything else fails the order. */
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function createCashfreeOrder(args: {
  orderId: string;
  amount: number;
  customer: { id: string; name: string; email: string; phone: string };
  returnUrl: string;
}): Promise<CashfreeOrder> {
  return cf<CashfreeOrder>('/orders', {
    method: 'POST',
    body: JSON.stringify({
      order_id: args.orderId,
      order_amount: Number(args.amount.toFixed(2)),
      order_currency: 'INR',
      customer_details: {
        customer_id: args.customer.id,
        customer_name: args.customer.name,
        customer_email: args.customer.email,
        customer_phone: args.customer.phone || '9999999999',
      },
      // Cashfree REJECTS a non-https return_url in production, and it fails the
      // whole order call — so an http:// storefront (local dev against live
      // keys) can't even reach the payment window. Omitting it is safe: the
      // SDK opens in a modal and hands control back to the page, which
      // confirms the payment itself.
      order_meta: isHttps(args.returnUrl) ? { return_url: args.returnUrl } : {},
    }),
  });
}

export async function getCashfreeOrder(orderId: string): Promise<CashfreeOrder> {
  return cf<CashfreeOrder>(`/orders/${encodeURIComponent(orderId)}`);
}

export async function createCashfreeRefund(args: {
  orderId: string;
  refundId: string;
  amount: number;
  note?: string;
}): Promise<{ refund_id: string; refund_status: string }> {
  return cf(`/orders/${encodeURIComponent(args.orderId)}/refunds`, {
    method: 'POST',
    body: JSON.stringify({
      refund_id: args.refundId,
      refund_amount: Number(args.amount.toFixed(2)),
      refund_note: args.note ?? 'Refund from 10X',
    }),
  });
}

/**
 * Webhook signature check: base64(HMAC-SHA256(timestamp + rawBody, secretKey)).
 * Headers: x-webhook-signature, x-webhook-timestamp.
 */
export async function verifyCashfreeWebhook(
  rawBody: string,
  signature: string,
  timestamp: string,
): Promise<boolean> {
  const { secretKey } = creds();
  if (!secretKey || !signature || !timestamp) return false;
  const expected = crypto.createHmac('sha256', secretKey).update(timestamp + rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function testCashfreeConnection(): Promise<{ ok: boolean; message: string }> {
  if (!(await isCashfreeConfigured())) return { ok: false, message: 'Cashfree keys are not set.' };
  try {
    await cf('/orders/connection-test-nonexistent');
    return { ok: true, message: 'Cashfree connection works.' };
  } catch (err) {
    // A 404-style "order not found" still proves the credentials work.
    const msg = err instanceof Error ? err.message : '';
    if (/not.*found|does not exist/i.test(msg)) {
      return { ok: true, message: `Cashfree credentials verified (${await cashfreeMode()}).` };
    }
    return { ok: false, message: msg || 'Cashfree connection failed.' };
  }
}
