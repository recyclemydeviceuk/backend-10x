import { Router } from 'express';
import { Order } from '../../models/Order';
import { asyncHandler } from '../../utils/asyncHandler';
import { requireCustomer } from '../../middleware/customerAuth';
import { ApiError } from '../../utils/ApiError';
import { getCashfreeOrder } from '../../services/cashfree';
import {
  applyStatusChange,
  autoRefundOnCancel,
  markOrderConfirmedPaid,
  markOrderPaymentFailed,
  markPendingCheckoutFailed,
  materializePendingCheckout,
} from '../../services/orderLifecycle';
import { PendingCheckout } from '../../models/PendingCheckout';
import { logEvent } from '../../models/Event';
import { CustomerQuery } from '../../models/Query';
import { nextInvoiceNumber, nextQueryReference } from '../../models/Counter';
import { emails } from '../../services/emails';
import { clearCartForRequest } from '../../services/cartSession';
import { renderInvoiceHtml } from '../../services/invoice';

/** Stages where nothing has physically left yet. */
const CANCELLABLE = ['placed', 'confirmed', 'packed'];

export const myOrdersRouter = Router();

const orderView = (o: InstanceType<typeof Order>) => ({
  id: o.id,
  reference: o.reference,
  items: o.items,
  subtotal: o.subtotal,
  discount: o.discount,
  shippingFee: o.shippingFee,
  total: o.total,
  couponCode: o.couponCode,
  paymentMethod: o.paymentMethod,
  paymentStatus: o.paymentStatus,
  status: o.status,
  address: o.address,
  timeline: o.timeline,
  courier: o.shipment?.courier || o.courier,
  trackingNumber: o.shipment?.awb || o.trackingNumber,
  /** The courier's own words, verbatim from Shiprocket tracking. */
  courierStatus: o.shipment?.status || '',
  courierSyncedAt: o.shipment?.lastSyncedAt ?? null,
  invoiceNo: o.invoiceNo,
  estimatedDelivery: o.estimatedDelivery,
  subscriptionId: o.subscriptionId,
  placedAt: o.placedAt,
});

myOrdersRouter.get(
  '/orders',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const orders = await Order.find({ customerId: req.customer!.id }).sort({ placedAt: -1 }).limit(50);
    res.json({ ok: true, orders: orders.map(orderView) });
  }),
);

myOrdersRouter.get(
  '/orders/:reference',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const order = await Order.findOne({ reference: req.params.reference, customerId: req.customer!.id });
    if (!order) throw ApiError.notFound('Order not found.');
    res.json({ ok: true, order: orderView(order) });
  }),
);

/**
 * Called by the storefront's payment-return page: re-checks the Cashfree
 * status so the customer sees "paid" even if the webhook is a beat behind.
 */
myOrdersRouter.post(
  '/orders/:reference/confirm-payment',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const reference = req.params.reference;

    // An online checkout has no order yet. Ask the gateway what actually
    // happened and create one ONLY if the payment cleared.
    const pending = await PendingCheckout.findOne({ reference, customerId: req.customer!.id });
    if (pending && !pending.orderId) {
      if (!pending.cashfree.orderId) throw ApiError.notFound('Order not found.');

      const cf = await getCashfreeOrder(pending.cashfree.orderId);
      if (cf.order_status === 'PAID') {
        const created = await materializePendingCheckout(pending);
        await clearCartForRequest(req, res);
        if (created) return res.json({ ok: true, order: orderView(created) });
      }
      if (cf.order_status === 'EXPIRED' || cf.order_status === 'TERMINATED') {
        await markPendingCheckoutFailed(pending);
        return res.status(202).json({
          ok: false,
          state: 'failed',
          message: 'That payment didn’t go through, so no order was created. Nothing has been charged.',
        });
      }
      // ACTIVE — still on the gateway, or the bank is slow to settle.
      return res.status(202).json({
        ok: false,
        state: 'pending',
        message: 'We’re still waiting for your bank to confirm this payment.',
      });
    }

    const order = await Order.findOne({ reference, customerId: req.customer!.id });
    if (!order) throw ApiError.notFound('Order not found.');
    if (order.paymentMethod === 'online' && order.paymentStatus === 'pending' && order.cashfree.orderId) {
      const cf = await getCashfreeOrder(order.cashfree.orderId);
      if (cf.order_status === 'PAID') {
        await markOrderConfirmedPaid(order);
        await clearCartForRequest(req, res);
      } else if (cf.order_status === 'EXPIRED' || cf.order_status === 'TERMINATED') {
        await markOrderPaymentFailed(order);
      }
    }
    res.json({ ok: true, order: orderView(order) });
  }),
);

/**
 * Cancel an order the customer no longer wants.
 *
 * Only before it leaves the warehouse — once a parcel is with the courier the
 * route back is a return, not a cancellation, and pretending otherwise leaves
 * a cancelled order physically in transit.
 *
 * A prepaid order is NOT auto-refunded here: the money goes back through the
 * refund flow so there is one audited path for it, and the team is told.
 */
myOrdersRouter.post(
  '/orders/:reference/cancel',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const order = await Order.findOne({ reference: req.params.reference, customerId: req.customer!.id });
    if (!order) throw ApiError.notFound('Order not found.');

    if (order.status === 'cancelled') throw ApiError.badRequest('This order is already cancelled.');
    if (!CANCELLABLE.includes(order.status)) {
      throw ApiError.badRequest('This order is already on its way — start a return once it arrives.');
    }

    order.notes.push({ by: order.customerName, text: 'Cancelled by the customer.', at: new Date() });
    await applyStatusChange(order, 'cancelled');

    // COD was never collected, so it simply stops being owed.
    if (order.paymentMethod === 'cod' && order.paymentStatus === 'pending') {
      order.paymentStatus = 'failed';
      await order.save();
    }

    // A paid online order refunds ITSELF on cancellation — no one in the
    // loop. A gateway failure flags the order for the team instead of
    // erroring at the customer.
    const refundStarted = await autoRefundOnCancel(order);

    await logEvent(
      'order',
      `${order.reference} cancelled by customer`,
      order.paymentStatus === 'refunded'
        ? `₹${order.total.toLocaleString('en-IN')} auto-refunded`
        : order.paymentStatus === 'paid'
          ? `₹${order.total.toLocaleString('en-IN')} REFUND FAILED — action needed`
          : order.customerName,
      `/orders/${order.id}`,
    );

    res.json({ ok: true, refundStarted, order: orderView(order) });
  }),
);

/**
 * Order-help chat: "Request a call back". Lands in the same queries inbox the
 * team already watches, tagged so it reads as "phone this customer" rather
 * than a message to answer by email. One open request per order — asking
 * twice from the chat just re-confirms the first one.
 */
myOrdersRouter.post(
  '/orders/:reference/callback',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const order = await Order.findOne({ reference: req.params.reference, customerId: req.customer!.id });
    if (!order) throw ApiError.notFound('Order not found.');

    const existing = await CustomerQuery.findOne({
      topic: 'callback',
      orderReference: order.reference,
      email: order.customerEmail.toLowerCase(),
      status: { $in: ['new', 'open'] },
    });
    if (existing) {
      return res.json({ ok: true, reference: existing.reference, already: true });
    }

    const phone = order.address.phone || '';
    const reference = await nextQueryReference();
    const created = await CustomerQuery.create({
      reference,
      topic: 'callback',
      name: order.customerName,
      email: order.customerEmail,
      phone,
      orderReference: order.reference,
      message: `This customer needs a call back about order ${order.reference}${phone ? ` — phone ${phone}` : ''}.`,
      status: 'new',
    });
    await logEvent('query', `Call back requested — ${order.reference}`, `${order.customerName}${phone ? ` · ${phone}` : ''}`, `/queries/${created.id}`);

    res.status(201).json({ ok: true, reference, already: false });
  }),
);

/**
 * The customer's copy of the invoice — same document the panel prints.
 * Only a paid (or refunded, i.e. was-paid) order has an invoice.
 */
myOrdersRouter.get(
  '/orders/:reference/invoice',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const order = await Order.findOne({ reference: req.params.reference, customerId: req.customer!.id });
    if (!order) throw ApiError.notFound('Order not found.');
    if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'refunded') {
      throw ApiError.badRequest('The invoice is issued once the order is paid.');
    }
    if (!order.invoiceNo) {
      order.invoiceNo = await nextInvoiceNumber();
      await order.save();
    }
    const html = await renderInvoiceHtml(order, { toolbar: true });
    res.type('html').send(html);
  }),
);
