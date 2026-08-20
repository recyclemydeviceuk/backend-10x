import { Router } from 'express';
import { z } from 'zod';
import { Subscription } from '../../models/Subscription';
import { Customer } from '../../models/Customer';
import { Product } from '../../models/Product';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requireCustomer } from '../../middleware/customerAuth';
import { ApiError } from '../../utils/ApiError';
import { logEvent } from '../../models/Event';
import { env } from '../../config/env';
import { emails } from '../../services/emails';
import {
  createAutopaySubscription,
  getAutopaySubscription,
  manageAutopaySubscription,
} from '../../services/cashfreeSubscriptions';

export const mySubscriptionsRouter = Router();

/** How soon a restarted plan's first box goes out. */
const RESTART_SHIPS_IN_DAYS = 3;

const view = (s: InstanceType<typeof Subscription>, oneTimePrice?: number) => ({
  reference: s.reference,
  planName: s.planName,
  sku: s.sku,
  packets: s.packets,
  quantity: s.quantity,
  price: s.price,
  intervalDays: s.intervalDays,
  status: s.status,
  nextDelivery: s.nextDelivery,
  cyclesDelivered: s.cyclesDelivered,
  startedAt: s.startedAt,
  address: s.address,
  autopay: {
    status: s.autopay?.status || '',
    authorizedAt: s.autopay?.authorizedAt ?? null,
  },
  /**
   * What subscribing saves per cycle versus the one-time price. Read from the
   * catalogue, so a price change in the panel is reflected here rather than
   * being frozen at the moment the plan started.
   */
  savingsPerCycle: oneTimePrice && oneTimePrice > s.price ? (oneTimePrice - s.price) * s.quantity : 0,
});

/** The current one-time price of each plan's pack, in one pass. */
async function oneTimePrices(subs: InstanceType<typeof Subscription>[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const products = await Product.find({ _id: { $in: subs.map((s) => s.productId) } });
  for (const product of products) {
    for (const tier of product.tiers) prices.set(`${product.id}:${tier.id}`, tier.oneTimePrice);
  }
  return prices;
}

mySubscriptionsRouter.get(
  '/subscriptions',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const subs = await Subscription.find({ customerId: req.customer!.id }).sort({ startedAt: -1 });
    const prices = await oneTimePrices(subs);
    res.json({
      ok: true,
      subscriptions: subs.map((s) => view(s, prices.get(`${String(s.productId)}:${s.tierId}`))),
    });
  }),
);

/** pause | resume | restart | cancel — the customer's own controls, no lock-in. */
mySubscriptionsRouter.post(
  '/subscriptions/:reference/action',
  requireCustomer,
  validateBody(z.object({ action: z.enum(['pause', 'resume', 'restart', 'cancel']) })),
  asyncHandler(async (req, res) => {
    const sub = await Subscription.findOne({ reference: req.params.reference, customerId: req.customer!.id });
    if (!sub) throw ApiError.notFound('Subscription not found.');
    const { action } = req.body as { action: 'pause' | 'resume' | 'restart' | 'cancel' };

    if (action === 'pause') {
      if (sub.status !== 'active') throw ApiError.badRequest('Only active plans can be paused.');
      sub.status = 'paused';
      sub.nextDelivery = null;
    } else if (action === 'resume') {
      if (sub.status !== 'paused') throw ApiError.badRequest('Only paused plans can be resumed.');
      sub.status = 'active';
      sub.nextDelivery = new Date(Date.now() + sub.intervalDays * 86400_000);
    } else if (action === 'restart') {
      if (sub.status === 'active') throw ApiError.badRequest('This plan is already running.');
      // A restarted plan ships with the next dispatch rather than waiting a
      // full cycle — someone restarting today wants the product now, not in
      // four weeks. The cadence continues from there.
      sub.status = 'active';
      sub.nextDelivery = new Date(Date.now() + RESTART_SHIPS_IN_DAYS * 86400_000);
    } else {
      if (sub.status === 'cancelled') throw ApiError.badRequest('This plan is already cancelled.');
      sub.status = 'cancelled';
      sub.nextDelivery = null;
    }
    await sub.save();

    // Keep the money side in step with the plan: pausing stops charges,
    // cancelling revokes the mandate outright. A gateway hiccup never blocks
    // the customer's own action — the sync worker reconciles later.
    if (sub.autopay?.subscriptionId && sub.autopay.status && sub.autopay.status !== 'cancelled') {
      const gatewayAction = action === 'pause' ? 'PAUSE' : action === 'cancel' ? 'CANCEL' : 'ACTIVATE';
      try {
        await manageAutopaySubscription(sub.autopay.subscriptionId, gatewayAction);
        sub.autopay.status = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'active';
        await sub.save();
      } catch {
        /* reconciled by syncing */
      }
    }

    const stillActive = await Subscription.exists({ customerId: req.customer!.id, status: { $in: ['active', 'paused'] } });
    await Customer.updateOne({ _id: req.customer!.id }, { $set: { hasSubscription: Boolean(stillActive) } });
    await logEvent('subscription', `${sub.reference} ${sub.status}`, req.customer!.name, '/subscriptions');
    await emails.subscriptionUpdated({
      email: req.customer!.email,
      name: req.customer!.name,
      reference: sub.reference,
      planName: sub.planName,
      status: sub.status,
      nextDelivery: sub.nextDelivery ?? null,
    });

    const prices = await oneTimePrices([sub]);
    res.json({ ok: true, subscription: view(sub, prices.get(`${String(sub.productId)}:${sub.tierId}`)) });
  }),
);

/* ------------------------------------------------------------- auto-pay */

/**
 * Start auto-pay for a plan.
 *
 * Creates the mandate at Cashfree and hands back a session id; the storefront
 * opens it so the customer can approve the mandate in their UPI/bank app.
 * Nothing is charged here — approval only. The webhook (or the refresh call
 * below) flips the plan to auto-pay once the bank confirms.
 */
mySubscriptionsRouter.post(
  '/subscriptions/:reference/autopay/setup',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const sub = await Subscription.findOne({ reference: req.params.reference, customerId: req.customer!.id });
    if (!sub) throw ApiError.notFound('Subscription not found.');
    if (sub.status !== 'active') throw ApiError.badRequest('Start auto-pay on an active plan.');
    if (sub.autopay.status === 'active') throw ApiError.badRequest('Auto-pay is already running for this plan.');

    const customer = await Customer.findById(req.customer!.id);
    if (!customer) throw ApiError.unauthorized();

    // One mandate per plan: reuse our reference, suffixed on retries so a
    // failed first attempt doesn't collide at the gateway.
    const gatewayId = sub.autopay.subscriptionId && sub.autopay.status === 'failed'
      ? `${sub.reference}-R${Date.now().toString(36).slice(-4)}`
      : sub.autopay.subscriptionId || sub.reference;

    const created = await createAutopaySubscription({
      reference: gatewayId,
      planName: sub.planName,
      amount: sub.price * sub.quantity,
      intervalDays: sub.intervalDays,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: sub.address?.phone || customer.phone,
      },
      returnUrl: `${env.storefrontUrl}/account/subscriptions?autopay=${sub.reference}`,
    });

    sub.autopay.subscriptionId = created.subscription_id;
    sub.autopay.status = 'initialized';
    await sub.save();

    res.json({
      ok: true,
      autopay: {
        gateway: 'cashfree',
        environment: env.cashfree.env,
        subscriptionSessionId: created.subscription_session_id,
      },
    });
  }),
);

/**
 * Re-check the mandate with the gateway — called when the customer lands back
 * from approval, and safe to call any time.
 */
mySubscriptionsRouter.post(
  '/subscriptions/:reference/autopay/refresh',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const sub = await Subscription.findOne({ reference: req.params.reference, customerId: req.customer!.id });
    if (!sub) throw ApiError.notFound('Subscription not found.');
    if (!sub.autopay.subscriptionId) throw ApiError.badRequest('Auto-pay was never started for this plan.');

    const remote = await getAutopaySubscription(sub.autopay.subscriptionId);
    applyGatewayAutopayStatus(sub, remote.subscription_status);
    await sub.save();

    const prices = await oneTimePrices([sub]);
    res.json({ ok: true, subscription: view(sub, prices.get(`${String(sub.productId)}:${sub.tierId}`)) });
  }),
);

/** Map Cashfree's subscription status words onto our autopay state. */
export function applyGatewayAutopayStatus(
  sub: InstanceType<typeof Subscription>,
  gatewayStatus: string,
): void {
  const status = gatewayStatus.toUpperCase();
  if (status === 'ACTIVE') {
    sub.autopay.status = 'active';
    if (!sub.autopay.authorizedAt) sub.autopay.authorizedAt = new Date();
  } else if (status === 'PAUSED') sub.autopay.status = 'paused';
  else if (status === 'CANCELLED' || status === 'EXPIRED') sub.autopay.status = 'cancelled';
  else if (status === 'INITIALIZED' || status === 'PENDING' || status === 'BANK_APPROVAL_PENDING') sub.autopay.status = 'initialized';
  else if (status === 'FAILED') sub.autopay.status = 'failed';
}
