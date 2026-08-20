import { ApiError } from '../utils/ApiError';
import { getSettings } from '../models/Setting';
import { env } from '../config/env';
import type { OrderDoc } from '../models/Order';
import type { ReturnRequestDoc } from '../models/ReturnRequest';

// Shiprocket REST — token cached ~8 days, refreshed on demand.

const BASE = 'https://apiv2.shiprocket.in/v1/external';

let cachedToken: { token: string; expiresAt: number; forEmail: string } | null = null;

export async function isShiprocketConfigured(): Promise<boolean> {
  return Boolean(env.shiprocket.email && env.shiprocket.password);
}

async function token(): Promise<string> {
  const { email, password } = env.shiprocket;
  if (!email || !password) {
    throw ApiError.badRequest('Shiprocket is not configured on the backend.');
  }
  // Credentials changed from the panel invalidate the cached token.
  if (cachedToken && cachedToken.expiresAt > Date.now() && cachedToken.forEmail === email) {
    return cachedToken.token;
  }

  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
  if (!res.ok || !data.token) {
    throw new ApiError(502, data.message || 'Shiprocket sign-in failed — check the API user credentials.');
  }
  cachedToken = {
    token: data.token,
    expiresAt: Date.now() + 8 * 86400_000,
    forEmail: email,
  };
  return data.token;
}

async function sr<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await token()}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = (data.message as string) || `Shiprocket error ${res.status}`;
    throw new ApiError(res.status >= 500 ? 502 : 400, message);
  }
  return data as T;
}

const orderItems = (order: OrderDoc) =>
  order.items.map((i) => ({
    name: `${i.name}${i.tierName ? ` — ${i.tierName}` : ''}`,
    sku: `${i.productId}-${i.tierId}`.slice(0, 40),
    units: i.quantity,
    selling_price: i.unitPrice,
  }));

/** Books a forward shipment for a paid order. */
export async function createShiprocketOrder(order: OrderDoc & { reference: string }) {
  const [first, ...rest] = order.customerName.split(' ');
  return sr<{ order_id: number; shipment_id: number }>('/orders/create/adhoc', {
    method: 'POST',
    body: JSON.stringify({
      order_id: order.reference,
      order_date: new Date(order.placedAt).toISOString().slice(0, 16).replace('T', ' '),
      pickup_location: env.shiprocket.pickupLocation,
      billing_customer_name: first,
      billing_last_name: rest.join(' ') || '.',
      billing_address: order.address.line1,
      billing_address_2: order.address.line2,
      billing_city: order.address.city,
      billing_pincode: order.address.pincode,
      billing_state: order.address.state,
      billing_country: 'India',
      billing_email: order.customerEmail,
      billing_phone: order.address.phone || '9999999999',
      shipping_is_billing: true,
      order_items: orderItems(order),
      payment_method: order.paymentMethod === 'cod' ? 'COD' : 'Prepaid',
      sub_total: order.total,
      length: 15,
      breadth: 15,
      height: 10,
      weight: env.shiprocket.packageWeightKg || 0.5,
    }),
  });
}

export async function assignAwb(shipmentId: string) {
  return sr<{ response?: { data?: { awb_code?: string; courier_name?: string } } }>(
    '/courier/assign/awb',
    { method: 'POST', body: JSON.stringify({ shipment_id: shipmentId }) },
  );
}

export async function requestPickup(shipmentId: string) {
  return sr('/courier/generate/pickup', {
    method: 'POST',
    body: JSON.stringify({ shipment_id: [Number(shipmentId)] }),
  });
}

export async function generateLabel(shipmentId: string) {
  return sr<{ label_url?: string }>('/courier/generate/label', {
    method: 'POST',
    body: JSON.stringify({ shipment_id: [Number(shipmentId)] }),
  });
}

export async function generateShiprocketInvoice(srOrderId: string) {
  return sr<{ invoice_url?: string }>('/orders/print/invoice', {
    method: 'POST',
    body: JSON.stringify({ ids: [Number(srOrderId)] }),
  });
}

export async function trackAwb(awb: string) {
  return sr<{ tracking_data?: { shipment_track?: { current_status?: string }[] } }>(
    `/courier/track/awb/${encodeURIComponent(awb)}`,
  );
}

export async function cancelShiprocketOrder(srOrderId: string) {
  return sr('/orders/cancel', { method: 'POST', body: JSON.stringify({ ids: [Number(srOrderId)] }) });
}

/** Reverse pickup: customer address → warehouse (Settings → warehouse). */
export async function createShiprocketReturn(ret: ReturnRequestDoc & { reference: string }, order: OrderDoc) {
  const settings = await getSettings();
  const wh = settings.warehouse;
  if (!wh?.address || !wh.pincode) {
    throw ApiError.badRequest('Set the warehouse address in Settings → Shipping before approving returns.');
  }
  const [first, ...rest] = ret.customerName.split(' ');
  return sr<{ order_id: number; shipment_id: number }>('/orders/create/return', {
    method: 'POST',
    body: JSON.stringify({
      order_id: `${ret.reference}`,
      order_date: new Date().toISOString().slice(0, 10),
      // pickup_* = the customer (where the parcel starts)
      pickup_customer_name: first,
      pickup_last_name: rest.join(' ') || '.',
      pickup_address: order.address.line1,
      pickup_address_2: order.address.line2,
      pickup_city: order.address.city,
      pickup_state: order.address.state,
      pickup_country: 'India',
      pickup_pincode: order.address.pincode,
      pickup_email: ret.customerEmail,
      pickup_phone: order.address.phone || '9999999999',
      // shipping_* = the warehouse (where it ends)
      shipping_customer_name: wh.name || '10X Fulfilment Centre',
      shipping_address: wh.address,
      shipping_city: wh.city,
      shipping_state: wh.state,
      shipping_country: 'India',
      shipping_pincode: wh.pincode,
      shipping_phone: wh.phone || '9999999999',
      order_items: order.items.map((i) => ({
        name: `${i.name}${i.tierName ? ` — ${i.tierName}` : ''}`,
        sku: `${i.productId}-${i.tierId}`.slice(0, 40),
        units: i.quantity,
        selling_price: i.unitPrice,
      })),
      payment_method: 'Prepaid',
      sub_total: ret.amount,
      length: 15,
      breadth: 15,
      height: 10,
      weight: env.shiprocket.packageWeightKg || 0.5,
    }),
  });
}

/** Maps Shiprocket tracking statuses onto our order statuses. */
export const TRACK_TO_STATUS: Record<string, string> = {
  'PICKUP SCHEDULED': 'packed',
  'PICKUP GENERATED': 'packed',
  'PICKED UP': 'shipped',
  'IN TRANSIT': 'shipped',
  SHIPPED: 'shipped',
  'OUT FOR DELIVERY': 'out_for_delivery',
  DELIVERED: 'delivered',
  'RTO INITIATED': 'returned',
  'RTO DELIVERED': 'returned',
  CANCELED: 'cancelled',
  CANCELLED: 'cancelled',
};

export async function testShiprocketConnection(): Promise<{ ok: boolean; message: string }> {
  if (!(await isShiprocketConfigured())) return { ok: false, message: 'Shiprocket credentials are not set.' };
  try {
    await token();
    return { ok: true, message: 'Shiprocket sign-in works.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Shiprocket connection failed.' };
  }
}
