import { getSettings } from '../models/Setting';
import { env } from '../config/env';
import { isShiprocketConfigured, quoteShipping } from './shiprocket';

// =========================================================
// One answer to "what does delivery cost?" — used by the cart (as the
// customer types a pincode), the checkout (with the chosen address) and the
// manual order form. The store's delivery mode decides the method:
//
//   free    → 0
//   priced  → flat fee, waived at or above the free-delivery threshold
//   live    → Shiprocket's real rate for that pincode and weight, waived at
//             or above the threshold; falls back to the flat fee when
//             Shiprocket can't answer, so a checkout never blocks on them.
// =========================================================

export type DeliveryQuote = {
  mode: 'free' | 'priced' | 'live';
  fee: number;
  /** Where the number came from. 'fallback' = live mode but Shiprocket didn't answer. */
  source: 'rule' | 'shiprocket' | 'fallback';
  courier?: string;
  etd?: string;
  days?: number | null;
  /** Orders at or above this ship free (0 = never). */
  freeOver: number;
  /** Live mode needs a pincode before it can quote. */
  needsPincode: boolean;
};

const liveCache = new Map<string, { at: number; quote: Awaited<ReturnType<typeof quoteShipping>> }>();
const LIVE_TTL_MS = 10 * 60_000;

export async function quoteDelivery(args: {
  /** Subtotal after discount — what the free-over threshold is measured on. */
  amount: number;
  quantity: number;
  pincode?: string;
  cod?: boolean;
}): Promise<DeliveryQuote> {
  const settings = await getSettings();
  const { deliveryMode, freeShippingOver, flatShipping } = settings.store;
  const freeOver = deliveryMode === 'free' ? 0 : freeShippingOver;

  if (deliveryMode === 'free') return { mode: 'free', fee: 0, source: 'rule', freeOver: 0, needsPincode: false };

  const overThreshold = freeShippingOver > 0 && args.amount >= freeShippingOver;
  if (deliveryMode === 'priced') {
    return { mode: 'priced', fee: overThreshold ? 0 : flatShipping, source: 'rule', freeOver, needsPincode: false };
  }

  // live
  if (overThreshold) return { mode: 'live', fee: 0, source: 'rule', freeOver, needsPincode: false };
  const pincode = (args.pincode ?? '').trim();
  if (!/^\d{6}$/.test(pincode)) {
    return { mode: 'live', fee: flatShipping, source: 'fallback', freeOver, needsPincode: true };
  }
  if (!(await isShiprocketConfigured())) {
    return { mode: 'live', fee: flatShipping, source: 'fallback', freeOver, needsPincode: false };
  }

  const weightKg = Math.max(env.shiprocket.packageWeightKg || 0.5, 0.1) * Math.max(args.quantity, 1);
  const key = `${pincode}|${weightKg}|${args.cod ? 1 : 0}`;
  const cached = liveCache.get(key);
  try {
    const quote =
      cached && Date.now() - cached.at < LIVE_TTL_MS
        ? cached.quote
        : await quoteShipping({ deliveryPincode: pincode, weightKg, cod: Boolean(args.cod), declaredValue: args.amount });
    liveCache.set(key, { at: Date.now(), quote });
    return {
      mode: 'live',
      fee: quote.fee,
      source: 'shiprocket',
      courier: quote.courier,
      etd: quote.etd,
      days: quote.days,
      freeOver,
      needsPincode: false,
    };
  } catch {
    return { mode: 'live', fee: flatShipping, source: 'fallback', freeOver, needsPincode: false };
  }
}
