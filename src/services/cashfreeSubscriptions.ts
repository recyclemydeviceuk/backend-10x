import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

// =========================================================
// Cashfree Subscriptions — recurring mandates (UPI Autopay /
// eNACH / cards) and the charges raised against them.
//
// Same credentials as the payment gateway; the ONLY external
// requirement is the "Subscriptions" product being activated on
// the Cashfree account. Until it is, every call here fails with
// a product-not-enabled error, which callers surface as a plain
// "auto-pay isn't switched on yet" — nothing else breaks.
//
// Kept in its own module so a change in Cashfree's API shape is
// a one-file fix.
// =========================================================

const API_VERSION = '2023-08-01';

function base(): string {
  return env.cashfree.env === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

async function cf<T>(path: string, init?: RequestInit): Promise<T> {
  const { appId, secretKey } = env.cashfree;
  if (!appId || !secretKey) throw ApiError.badRequest('Cashfree is not configured on the backend.');

  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: {
      'x-client-id': appId,
      'x-client-secret': secretKey,
      'x-api-version': API_VERSION,
      'content-type': 'application/json',
      accept: 'application/json',
      ...init?.headers,
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const raw = (data.message as string) || `Cashfree error ${res.status}`;
    // The one setup error worth translating: the product isn't live yet.
    if (/not enabled|not activated|unauthorized to access subscriptions|feature is not/i.test(raw)) {
      throw ApiError.badRequest(
        'Auto-pay is not switched on for this Cashfree account yet — activate the Subscriptions product in the merchant dashboard.',
      );
    }
    throw new ApiError(res.status >= 500 ? 502 : 400, raw);
  }
  return data as T;
}

export type CashfreeSubscription = {
  subscription_id: string;
  subscription_status: string;
  subscription_session_id?: string;
  authorisation_details?: Record<string, unknown>;
};

/**
 * Create the mandate container for one of our subscriptions.
 *
 * The customer still has to APPROVE the mandate in their bank/UPI app — the
 * returned session id is what the storefront SDK opens for that approval.
 * `plan_max_amount` is padded above the cycle price so a panel price rise
 * within reason doesn't strand every existing mandate.
 */
export async function createAutopaySubscription(args: {
  reference: string;
  planName: string;
  amount: number;
  intervalDays: number;
  customer: { id: string; name: string; email: string; phone: string };
  returnUrl: string;
}): Promise<CashfreeSubscription> {
  // Two-step at the gateway: plan_details.plan_id only REFERENCES a plan, so
  // the plan is created first. One plan per subscription — prices differ per
  // tier and the panel can change them, so sharing plan ids buys nothing.
  const planId = `PLAN-${args.reference}`.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40);
  try {
    await cf('/plans', {
      method: 'POST',
      body: JSON.stringify({
        plan_id: planId,
        // Cashfree allows only alphanumerics and a few specials in plan names —
        // brand punctuation like "·" or "—" gets the whole call rejected.
        plan_name: args.planName.replace(/[^a-zA-Z0-9 _.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60),
        plan_type: 'PERIODIC',
        plan_currency: 'INR',
        plan_recurring_amount: Number(args.amount.toFixed(2)),
        plan_max_amount: Number((args.amount * 1.5).toFixed(2)),
        // Cashfree wants intervals in whole units of a type; days is the
        // safest fit for our "every N days" cadence.
        plan_intervals: args.intervalDays,
        plan_interval_type: 'DAY',
        plan_note: '10X subscription',
      }),
    });
  } catch (err) {
    // A retry after a half-finished attempt finds the plan already there —
    // that is fine, it is the exact plan we want.
    if (!(err instanceof ApiError && /already exists|duplicate/i.test(err.message))) throw err;
  }

  return cf<CashfreeSubscription>('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      subscription_id: args.reference,
      customer_details: {
        customer_name: args.customer.name,
        customer_email: args.customer.email,
        customer_phone: args.customer.phone || '9999999999',
      },
      plan_details: { plan_id: planId },
      authorization_details: {
        authorization_amount: 1,
        authorization_amount_refund: true,
      },
      subscription_meta: {
        return_url: args.returnUrl,
      },
      subscription_note: `10X ${args.reference}`,
    }),
  });
}

export async function getAutopaySubscription(subscriptionId: string): Promise<CashfreeSubscription> {
  return cf<CashfreeSubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

/** PAUSE / ACTIVATE / CANCEL the mandate at the gateway. */
export async function manageAutopaySubscription(
  subscriptionId: string,
  action: 'PAUSE' | 'ACTIVATE' | 'CANCEL',
): Promise<CashfreeSubscription> {
  return cf<CashfreeSubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}/manage`, {
    method: 'POST',
    body: JSON.stringify({ subscription_id: subscriptionId, action }),
  });
}

export type CashfreeSubscriptionPayment = {
  payment_id: string;
  payment_status: string;
  payment_amount: number;
};

/**
 * Raise one cycle's charge against an authorised mandate.
 *
 * RBI rules require the customer be pre-notified before an auto-debit;
 * Cashfree handles that itself from the schedule date, which is why the
 * charge is scheduled ~26h out rather than fired instantly.
 */
export async function raiseAutopayCharge(args: {
  subscriptionId: string;
  paymentId: string;
  amount: number;
  scheduleAt: Date;
}): Promise<CashfreeSubscriptionPayment> {
  return cf<CashfreeSubscriptionPayment>(
    `/subscriptions/${encodeURIComponent(args.subscriptionId)}/payments`,
    {
      method: 'POST',
      body: JSON.stringify({
        subscription_id: args.subscriptionId,
        payment_id: args.paymentId,
        payment_amount: Number(args.amount.toFixed(2)),
        payment_type: 'CHARGE',
        payment_schedule_date: args.scheduleAt.toISOString(),
        payment_remarks: '10X subscription cycle',
      }),
    },
  );
}

export async function getAutopayCharge(
  subscriptionId: string,
  paymentId: string,
): Promise<CashfreeSubscriptionPayment> {
  return cf<CashfreeSubscriptionPayment>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}/payments/${encodeURIComponent(paymentId)}`,
  );
}
