import { Router } from 'express';
import { z } from 'zod';
import { Product } from '../../models/Product';
import { Order } from '../../models/Order';
import { Customer } from '../../models/Customer';
import { nextOrderReference } from '../../models/Counter';
import { getSettings } from '../../models/Setting';
import { resolveCoupon } from '../../services/coupons';
import { logEvent } from '../../models/Event';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requireCustomer } from '../../middleware/customerAuth';
import { ApiError } from '../../utils/ApiError';
import { createCashfreeOrder, isCashfreeConfigured, cashfreeMode } from '../../services/cashfree';
import { env } from '../../config/env';
import {
  markOrderConfirmedPaid,
  markPendingCheckoutFailed,
  reserveStock,
} from '../../services/orderLifecycle';
import { PendingCheckout } from '../../models/PendingCheckout';

/** How long a payment session stays valid before the checkout is swept away. */
const CHECKOUT_WINDOW_MINUTES = 45;
import { clearCartForRequest } from '../../services/cartSession';

export const checkoutRouter = Router();

const addressSchema = z.object({
  fullName: z.string().trim().default(''),
  line1: z.string().trim().min(3, 'Address line is too short.'),
  line2: z.string().trim().default(''),
  landmark: z.string().trim().default(''),
  city: z.string().trim().min(2),
  state: z.string().trim().min(2),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits.'),
  phone: z.string().trim().regex(/^\d{10}$/, 'Phone must be 10 digits.'),
});

const checkoutSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        tierId: z.string().min(1),
        quantity: z.number().int().min(1).max(10),
        /** true = subscription pricing; creates a subscription for this line. */
        subscribe: z.boolean().optional().default(false),
      }),
    )
    .min(1, 'The cart is empty.'),
  address: addressSchema,
  paymentMethod: z.enum(['online', 'cod']),
  couponCode: z.string().trim().toUpperCase().optional().default(''),
});

/**
 * POST /checkout — prices are computed SERVER-SIDE from the catalog; the
 * client only sends product/tier ids and quantities.
 *
 * online → order stays pending + Cashfree payment_session_id is returned;
 *          the webhook (or payment sync) confirms it.
 * cod    → order is confirmed immediately.
 */
checkoutRouter.post(
  '/checkout',
  requireCustomer,
  validateBody(checkoutSchema),
  asyncHandler(async (req, res) => {
    const { items, address, paymentMethod, couponCode } = req.body as z.infer<typeof checkoutSchema>;
    const settings = await getSettings();

    if (paymentMethod === 'cod' && !settings.store.codEnabled) {
      throw ApiError.badRequest('Cash on delivery is not available right now.');
    }
    if (paymentMethod === 'online' && !(await isCashfreeConfigured())) {
      throw ApiError.badRequest('Online payment is temporarily unavailable — choose cash on delivery.');
    }

    /* ------------------------------------------ price + stock from catalog */
    let subtotal = 0;
    const lineItems: {
      productId: string;
      tierId: string;
      sku: string;
      name: string;
      tierName: string;
      packets: string;
      quantity: number;
      unitPrice: number;
      subscribe: boolean;
    }[] = [];

    for (const line of items) {
      const product = await Product.findOne({ _id: line.productId, status: 'active' });
      if (!product) throw ApiError.badRequest('One of the products is no longer available.');
      const tier = product.tiers.id(line.tierId);
      if (!tier || !tier.available) throw ApiError.badRequest(`${product.name}: that pack is not on sale.`);
      if (tier.stock < line.quantity) {
        throw ApiError.badRequest(`${product.name} — ${tier.name}: only ${tier.stock} left in stock.`);
      }
      const unitPrice = line.subscribe ? tier.subscribePrice : tier.oneTimePrice;
      subtotal += unitPrice * line.quantity;
      lineItems.push({
        productId: product.id,
        tierId: tier.id,
        // A readable SKU for invoices, exports and the packing slip.
        sku: `${product.slug.toUpperCase()}-${tier.packets}${line.subscribe ? '-SUB' : ''}`,
        name: product.name,
        tierName: tier.name,
        packets: `${tier.packets} Stick Packets`,
        quantity: line.quantity,
        unitPrice,
        subscribe: line.subscribe,
      });
    }

    /* ------------------------------------------------------------ coupon */
    let discount = 0;
    if (couponCode) {
      const resolved = await resolveCoupon(couponCode, subtotal, req.customer!.id);
      discount = resolved.discount;
    }

    const shippingFee =
      settings.store.deliveryMode === 'free'
        ? 0
        : subtotal - discount >= settings.store.freeShippingOver
          ? 0
          : settings.store.flatShipping;
    const total = subtotal - discount + shippingFee;

    /* ------------------------------------------------------------- order */
    const customer = await Customer.findById(req.customer!.id);
    if (!customer) throw ApiError.unauthorized();

    const reference = await nextOrderReference();

    /* ------------------------------------------------------------- COD */
    // Nothing is being collected up front, so this order is real immediately.
    if (paymentMethod === 'cod') {
      const order = await Order.create({
        reference,
        customerId: customer.id,
        customerName: customer.name,
        customerEmail: customer.email,
        items: lineItems,
        subtotal,
        discount,
        shippingFee,
        total,
        couponCode,
        channel: 'website',
        paymentMethod,
        paymentStatus: 'pending',
        payment: { provider: 'cod' },
        status: 'placed',
        address,
        timeline: [{ stage: 'placed', at: new Date() }],
        placedAt: new Date(),
      });

      try {
        await reserveStock(order);
      } catch (error) {
        order.paymentStatus = 'failed';
        order.status = 'cancelled';
        order.timeline.push({ stage: 'cancelled', at: new Date() });
        await order.save();
        throw error;
      }

      customer.lastActiveAt = new Date();
      await customer.save();
      await logEvent('order', `New order ${reference}`, `${customer.name} — ₹${total.toLocaleString('en-IN')}`, `/orders/${order.id}`);
      await markOrderConfirmedPaid(order);
      await clearCartForRequest(req, res);

      return res.status(201).json({
        ok: true,
        order: { id: order.id, reference, total, paymentMethod, status: order.status },
      });
    }

    /* ---------------------------------------------------------- online */
    // NO ORDER YET. Park everything needed to build one, hand the browser a
    // payment session, and create the order only when the money lands — an
    // order that exists before payment is an order the team has to chase and
    // the customer never placed.
    const pending = await PendingCheckout.create({
      reference,
      customerId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email,
      items: lineItems,
      subtotal,
      discount,
      shippingFee,
      total,
      couponCode,
      address,
      status: 'awaiting_payment',
      expiresAt: new Date(Date.now() + CHECKOUT_WINDOW_MINUTES * 60_000),
    });

    let cfOrder;
    try {
      cfOrder = await createCashfreeOrder({
        orderId: reference,
        amount: total,
        customer: { id: customer.id, name: customer.name, email: customer.email, phone: address.phone },
        // Some methods (UPI intent especially) leave the modal and come back
        // via a redirect — land on the same confirmation page either way, and
        // it re-checks the payment itself.
        returnUrl: `${env.storefrontUrl}/checkout/success?ref=${reference}`,
      });
    } catch (error) {
      await markPendingCheckoutFailed(pending);
      throw error;
    }

    pending.cashfree.orderId = cfOrder.order_id;
    pending.cashfree.paymentSessionId = cfOrder.payment_session_id ?? '';
    await pending.save();

    customer.lastActiveAt = new Date();
    await customer.save();

    res.status(201).json({
      ok: true,
      // Not an order yet — the reference is reserved, and the confirmation
      // page turns it into one once the gateway says the payment cleared.
      order: { id: null, reference, total, paymentMethod, status: 'awaiting_payment' },
      payment: {
        gateway: 'cashfree',
        environment: await cashfreeMode(),
        paymentSessionId: cfOrder.payment_session_id,
      },
    });
  }),
);
