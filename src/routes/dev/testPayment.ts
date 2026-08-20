import { Router } from 'express';
import { PendingCheckout } from '../../models/PendingCheckout';
import { asyncHandler } from '../../utils/asyncHandler';
import { requireCustomer } from '../../middleware/customerAuth';
import { ApiError } from '../../utils/ApiError';
import { materializePendingCheckout } from '../../services/orderLifecycle';
import { clearCartForRequest } from '../../services/cartSession';

// =========================================================
// TEST PAYMENTS — local development only.
//
// Settles a pending checkout as if the gateway had confirmed
// it, so the whole paid path can be exercised without a card:
// order created, stock taken, invoice numbered, email sent,
// panel updated, thank-you page settled.
//
// This route CREATES A PAID ORDER WITHOUT MONEY, so it is
// fenced in four ways:
//   1. the router is not mounted unless ALLOW_TEST_PAYMENTS=true
//   2. and never when NODE_ENV=production
//   3. the caller must hold the customer's own session token
//   4. it only settles that customer's own checkout
//
// It is not a substitute for one real transaction before
// launch — only that proves the webhook reaches this server.
// =========================================================

export const devTestPaymentRouter = Router();

devTestPaymentRouter.post(
  '/test-payment/:reference',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const pending = await PendingCheckout.findOne({
      reference: req.params.reference,
      customerId: req.customer!.id,
    });
    if (!pending) throw ApiError.notFound('No checkout is waiting on payment with that reference.');

    const order = await materializePendingCheckout(pending);
    if (!order) throw ApiError.badRequest('That checkout could not be settled.');
    await clearCartForRequest(req, res);

    res.json({
      ok: true,
      simulated: true,
      message: `${order.reference} settled as paid — no money moved.`,
      order: { id: order.id, reference: order.reference, status: order.status, paymentStatus: order.paymentStatus },
    });
  }),
);
