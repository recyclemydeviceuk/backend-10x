import { Router, raw, json } from 'express';
import { env } from '../config/env';
import { Order, canTransition, type OrderStatus } from '../models/Order';
import { verifyCashfreeWebhook } from '../services/cashfree';
import {
  markOrderConfirmedPaid,
  markOrderPaymentFailed,
  markPendingCheckoutFailed,
  materializePendingCheckout,
  applyStatusChange,
} from '../services/orderLifecycle';
import { PendingCheckout } from '../models/PendingCheckout';
import { Subscription } from '../models/Subscription';
import { applyGatewayAutopayStatus } from './public/subscriptions';
import { createCycleOrder } from '../services/syncing';
import { TRACK_TO_STATUS } from '../services/shiprocket';
import { logEvent } from '../models/Event';

export const webhooksRouter = Router();

// Pasting the webhook URL into a browser (or a dashboard "verify" ping) gets
// a plain answer instead of a 404 — the real work is POST-only.
webhooksRouter.get('/cashfree', (_req, res) => {
  res.json({ ok: true, message: 'Cashfree webhook endpoint. Cashfree POSTs signed events here.' });
});
webhooksRouter.get('/shiprocket', (_req, res) => {
  res.json({ ok: true, message: 'Shiprocket webhook endpoint. Shiprocket POSTs tracking updates here.' });
});

/**
 * Cashfree webhook — set the endpoint in the merchant dashboard to
 * POST <api>/api/v1/webhooks/cashfree. Signature is verified against the
 * RAW body, so this route parses its own body.
 */
webhooksRouter.post(
  '/cashfree',
  raw({ type: '*/*' }),
  async (req, res) => {
    try {
      const rawBody = (req.body as Buffer).toString('utf8');
      const signature = String(req.headers['x-webhook-signature'] ?? '');
      const timestamp = String(req.headers['x-webhook-timestamp'] ?? '');
      if (!(await verifyCashfreeWebhook(rawBody, signature, timestamp))) {
        return res.status(401).json({ ok: false, message: 'Bad signature.' });
      }

      const payload = JSON.parse(rawBody) as {
        type?: string;
        data?: {
          order?: { order_id?: string };
          payment?: { payment_status?: string; cf_payment_id?: string | number; payment_group?: string };
          refund?: { refund_status?: string; order_id?: string; refund_id?: string; refund_amount?: number };
          subscription_details?: { subscription_id?: string; subscription_status?: string };
          cf_payment_id?: string | number;
          payment_id?: string;
          payment_status?: string;
        };
      };
      const type = payload.type ?? '';

      if (type === 'PAYMENT_SUCCESS_WEBHOOK') {
        const reference = payload.data?.order?.order_id;
        const paymentId = String(payload.data?.payment?.cf_payment_id ?? '');
        const method = payload.data?.payment?.payment_group ?? '';

        // The money landed, so the order comes into existence here. This is
        // the primary path — the confirmation page is only a fallback for
        // when the webhook is a beat behind the customer.
        const pending = reference ? await PendingCheckout.findOne({ reference }) : null;
        if (pending) {
          const order = await materializePendingCheckout(pending);
          if (order && (paymentId || method)) {
            order.cashfree.paymentId = paymentId;
            order.payment.method = method;
            await order.save();
          }
        } else {
          // An order already exists (a retry, or a COD order paid online).
          const order = reference ? await Order.findOne({ reference }) : null;
          if (order && order.paymentStatus === 'pending') {
            order.cashfree.paymentId = paymentId;
            order.payment.method = method;
            await markOrderConfirmedPaid(order);
          }
        }
      } else if (type === 'PAYMENT_FAILED_WEBHOOK' || type === 'PAYMENT_USER_DROPPED_WEBHOOK') {
        const reference = payload.data?.order?.order_id;

        // A dropped payment closes the checkout. No order is created, so
        // there is nothing to cancel and nothing for the team to chase.
        const pending = reference ? await PendingCheckout.findOne({ reference }) : null;
        if (pending) {
          await markPendingCheckoutFailed(pending, type === 'PAYMENT_FAILED_WEBHOOK' ? 'failed' : 'abandoned');
        } else {
          const order = reference ? await Order.findOne({ reference }) : null;
          if (order && order.paymentStatus === 'pending') {
            await markOrderPaymentFailed(order);
            await logEvent('payment', `${order.reference} payment failed`, order.customerName, `/orders/${order.id}`);
          }
        }
      } else if (type === 'REFUND_STATUS_WEBHOOK') {
        const reference = payload.data?.refund?.order_id;
        const order = reference ? await Order.findOne({ reference }) : null;
        if (order && payload.data?.refund?.refund_status === 'SUCCESS' && order.paymentStatus !== 'refunded') {
          order.paymentStatus = 'refunded';
          const refundId = String(payload.data.refund.refund_id ?? '');
          if (!order.payment.refunds.some((r) => r.refundId === refundId)) {
            order.payment.refunds.push({
              refundId,
              amount: payload.data.refund.refund_amount ?? order.total,
              at: new Date(),
              note: 'Cashfree refund webhook',
            });
          }
          await order.save();
          await logEvent('payment', `${order.reference} refunded`, order.customerName, `/orders/${order.id}`);
        }
      } else if (type.startsWith('SUBSCRIPTION_')) {
        const subscriptionId = payload.data?.subscription_details?.subscription_id ?? '';
        const sub = subscriptionId
          ? await Subscription.findOne({ 'autopay.subscriptionId': subscriptionId })
          : null;

        if (sub && type === 'SUBSCRIPTION_STATUS_CHANGE_WEBHOOK') {
          // The mandate changed state at the bank — mirror it.
          applyGatewayAutopayStatus(sub, payload.data?.subscription_details?.subscription_status ?? '');
          await sub.save();
        } else if (sub && type === 'SUBSCRIPTION_PAYMENT_SUCCESS_WEBHOOK') {
          // The auto-debit cleared: this cycle's order is born paid. Idempotent
          // on the charge id, so the syncing sweep can't double it.
          const chargeId = String(payload.data?.payment_id ?? sub.autopay.pendingChargeId ?? '');
          if (chargeId) {
            const order = await createCycleOrder(sub, { paid: true, chargeId });
            sub.autopay.lastChargeStatus = 'success';
            if (sub.autopay.pendingChargeId === chargeId) {
              sub.autopay.pendingChargeId = '';
              sub.autopay.pendingChargeAt = null;
            }
            await sub.save();
            if (order) {
              await logEvent('subscription', `${sub.reference} auto-paid`, `Cycle order ${order.reference}`, `/orders/${order.id}`);
            }
          }
        } else if (sub && type === 'SUBSCRIPTION_PAYMENT_FAILED_WEBHOOK') {
          // Debit bounced — the syncing sweep ships the cycle pay-on-delivery
          // and tells the team; here we only record the failure.
          sub.autopay.lastChargeStatus = 'failed';
          await sub.save();
          await logEvent('subscription', `${sub.reference} auto-debit failed`, 'Will ship as pay-on-delivery', '/subscriptions');
        }
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[webhook:cashfree]', err);
      // 200 so Cashfree doesn't hammer retries for a parse problem we logged.
      res.json({ ok: false });
    }
  },
);

/**
 * Shiprocket tracking webhook — Settings → API → Webhooks in Shiprocket.
 * Payload carries awb + current_status.
 */
webhooksRouter.post('/shiprocket', json({ limit: '1mb' }), async (req, res) => {
  // Shiprocket sends the token configured in its dashboard as x-api-key.
  // When one is set on the server, anything without it is ignored — without
  // this check anyone who knows an AWB could mark a COD order delivered/paid.
  if (env.shiprocket.webhookToken) {
    const given = String(req.headers['x-api-key'] ?? req.headers['x-shiprocket-token'] ?? '');
    if (given !== env.shiprocket.webhookToken) return res.status(401).json({ ok: false, message: 'Bad token.' });
  }
  try {
    const body = (req.body ?? {}) as { awb?: string | number; current_status?: string };
    const awb = String(body.awb ?? '');
    const current = String(body.current_status ?? '').toUpperCase();
    if (awb && current) {
      const order = await Order.findOne({ 'shipment.awb': awb });
      const mapped = TRACK_TO_STATUS[current] as OrderStatus | undefined;
      // A cancelled or returned order is settled — a late courier scan must
      // not drag it back onto the happy path.
      const terminal = order?.status === 'cancelled' || order?.status === 'returned';
      if (order) {
        order.shipment.status = current;
        order.shipment.lastSyncedAt = new Date();
        if (mapped && mapped !== order.status && !terminal && canTransition(order.status, mapped)) {
          order.notes.push({ by: 'Sync', text: `Courier webhook: ${current}.`, at: new Date() });
          await applyStatusChange(order, mapped);
        } else {
          await order.save();
        }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[webhook:shiprocket]', err);
    res.json({ ok: false });
  }
});
