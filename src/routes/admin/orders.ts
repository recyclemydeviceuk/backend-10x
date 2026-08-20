import { Router } from 'express';
import { z } from 'zod';
import type { FilterQuery } from 'mongoose';
import { Order, ORDER_STATUSES, type OrderDoc, type OrderStatus } from '../../models/Order';
import { Customer } from '../../models/Customer';
import { nextOrderReference, nextInvoiceNumber } from '../../models/Counter';
import { logEvent } from '../../models/Event';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { ApiError } from '../../utils/ApiError';
import { pageQuery, pageMeta } from '../../utils/paginate';
import { renderInvoiceHtml } from '../../services/invoice';
import {
  createShiprocketOrder,
  assignAwb,
  requestPickup,
  generateLabel,
  generateShiprocketInvoice,
  trackAwb,
  cancelShiprocketOrder,
  TRACK_TO_STATUS,
} from '../../services/shiprocket';
import { getCashfreeOrder, createCashfreeRefund } from '../../services/cashfree';
import {
  applyStatusChange,
  autoRefundOnCancel,
  markOrderConfirmedPaid,
  markOrderPaymentFailed,
  refreshCustomerStats,
  stampTimeline,
} from '../../services/orderLifecycle';
import { emails } from '../../services/emails';

export const adminOrdersRouter = Router();

/* ---------------------------------------------------------------- listing */
adminOrdersRouter.get(
  '/',
  requirePermission('orders.view'),
  asyncHandler(async (req, res) => {
    const q = pageQuery(req);
    const filter: FilterQuery<OrderDoc> = {};
    if (req.query.status && ORDER_STATUSES.includes(req.query.status as OrderStatus)) {
      filter.status = req.query.status;
    }
    if (req.query.payment === 'online' || req.query.payment === 'cod') filter.paymentMethod = req.query.payment;
    if (req.query.type === 'website' || req.query.type === 'subscription') filter.channel = req.query.type;
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ reference: rx }, { customerName: rx }, { customerEmail: rx }];
    }
    if (req.query.from || req.query.to) {
      filter.placedAt = {};
      if (req.query.from) filter.placedAt.$gte = new Date(String(req.query.from));
      if (req.query.to) filter.placedAt.$lte = new Date(String(req.query.to));
    }
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ placedAt: -1 }).skip(q.skip).limit(q.per),
      Order.countDocuments(filter),
    ]);
    res.json({ ok: true, orders, ...pageMeta(total, q) });
  }),
);

adminOrdersRouter.get(
  '/:id',
  requirePermission('orders.view'),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw ApiError.notFound('Order not found.');
    res.json({ ok: true, order });
  }),
);

/* ----------------------------------------------------------- manual order */
adminOrdersRouter.post(
  '/',
  requirePermission('orders.create'),
  validateBody(
    z.object({
      customerId: z.string().min(1),
      items: z
        .array(
          z.object({
            productId: z.string().min(1),
            tierId: z.string().min(1),
            name: z.string().min(1),
            tierName: z.string().default(''),
            quantity: z.number().int().min(1),
            unitPrice: z.number().min(0),
          }),
        )
        .min(1),
      shippingFee: z.number().min(0).default(0),
      discount: z.number().min(0).default(0),
      paymentMethod: z.enum(['online', 'cod']),
      address: z.object({
        line1: z.string().min(3),
        line2: z.string().default(''),
        city: z.string().min(2),
        state: z.string().min(2),
        pincode: z.string().regex(/^\d{6}$/),
        phone: z.string().default(''),
      }),
      note: z.string().default(''),
    }),
  ),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.body.customerId);
    if (!customer) throw ApiError.badRequest('Pick a customer.');
    const subtotal = req.body.items.reduce(
      (s: number, i: { unitPrice: number; quantity: number }) => s + i.unitPrice * i.quantity,
      0,
    );
    const total = subtotal - req.body.discount + req.body.shippingFee;
    const reference = await nextOrderReference();
    const order = await Order.create({
      reference,
      customerId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email,
      items: req.body.items,
      subtotal,
      discount: req.body.discount,
      shippingFee: req.body.shippingFee,
      total,
      channel: 'website',
      paymentMethod: req.body.paymentMethod,
      paymentStatus: 'pending',
      status: 'placed',
      address: req.body.address,
      timeline: [{ stage: 'placed', at: new Date() }],
      notes: req.body.note
        ? [{ by: req.admin!.name, text: req.body.note, at: new Date() }]
        : [],
      placedAt: new Date(),
    });
    await refreshCustomerStats(customer._id);
    await logEvent('order', `Manual order ${reference}`, `by ${req.admin!.name}`, `/orders/${order.id}`);
    res.status(201).json({ ok: true, order });
  }),
);

/* ------------------------------------------------------------ status/notes */
adminOrdersRouter.patch(
  '/:id/status',
  requirePermission('orders.status'),
  validateBody(z.object({ status: z.enum(ORDER_STATUSES) })),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw ApiError.notFound('Order not found.');
    order.notes.push({ by: req.admin!.name, text: `Status set to ${req.body.status}.`, at: new Date() });
    await applyStatusChange(order, req.body.status);
    // Cancellation sends the money back on its own — same rule as when the
    // customer cancels, so no paid-and-cancelled order ever waits on a human.
    if (req.body.status === 'cancelled') await autoRefundOnCancel(order);
    res.json({ ok: true, order });
  }),
);

adminOrdersRouter.post(
  '/:id/notes',
  requirePermission('orders.notes'),
  validateBody(z.object({ text: z.string().trim().min(1) })),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw ApiError.notFound('Order not found.');
    order.notes.push({ by: req.admin!.name, text: req.body.text, at: new Date() });
    await order.save();
    res.json({ ok: true, order });
  }),
);

/* ----------------------------------------------------------------- refund */
adminOrdersRouter.post(
  '/:id/refund',
  requirePermission('orders.refund'),
  validateBody(z.object({ note: z.string().trim().default('') })),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw ApiError.notFound('Order not found.');
    if (order.paymentStatus !== 'paid') throw ApiError.badRequest('Only paid orders can be refunded.');

    if (order.paymentMethod === 'online' && order.cashfree.orderId) {
      const refund = await createCashfreeRefund({
        orderId: order.cashfree.orderId,
        refundId: `refund-${order.reference}-${Date.now().toString(36)}`,
        amount: order.total,
        note: req.body.note || `Refund for ${order.reference}`,
      });
      order.cashfree.refundId = refund.refund_id;
      order.payment.refunds.push({
        refundId: refund.refund_id,
        amount: order.total,
        at: new Date(),
        note: req.body.note,
      });
    } else {
      // COD, or a prepaid order with no gateway link — record the payout.
      order.payment.refunds.push({
        refundId: '',
        amount: order.total,
        at: new Date(),
        note: req.body.note || 'Manual payout',
      });
    }
    order.paymentStatus = 'refunded';
    order.notes.push({
      by: req.admin!.name,
      text: `Refund of ₹${order.total.toLocaleString('en-IN')} issued${order.paymentMethod === 'cod' ? ' (manual COD payout)' : ' via Cashfree'}.${req.body.note ? ` ${req.body.note}` : ''}`,
      at: new Date(),
    });
    await order.save();
    await logEvent('payment', `${order.reference} refunded`, `₹${order.total.toLocaleString('en-IN')}`, `/orders/${order.id}`);
    await emails.orderRefunded(order);
    res.json({ ok: true, order });
  }),
);

/* ------------------------------------------------------------ payment sync */
adminOrdersRouter.post(
  '/:id/sync-payment',
  requirePermission('transactions.sync'),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw ApiError.notFound('Order not found.');
    if (order.paymentMethod !== 'online' || !order.cashfree.orderId) {
      throw ApiError.badRequest('This order has no Cashfree payment to sync.');
    }
    const cf = await getCashfreeOrder(order.cashfree.orderId);
    if (cf.order_status === 'PAID' && order.paymentStatus === 'pending') {
      await markOrderConfirmedPaid(order);
    } else if ((cf.order_status === 'EXPIRED' || cf.order_status === 'TERMINATED') && order.paymentStatus === 'pending') {
      await markOrderPaymentFailed(order);
    }
    res.json({ ok: true, order, gatewayStatus: cf.order_status });
  }),
);

/* --------------------------------------------------------------- delete */
adminOrdersRouter.delete(
  '/:id',
  requirePermission('orders.delete'),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw ApiError.notFound('Order not found.');
    await order.deleteOne();
    await refreshCustomerStats(order.customerId);
    res.json({ ok: true, message: `${order.reference} deleted.` });
  }),
);

/* ------------------------------------------------------------- fulfilment */
adminOrdersRouter.post(
  '/:id/shipment',
  requirePermission('fulfilment.create'),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw ApiError.notFound('Order not found.');
    if (order.shipment.shipmentId) throw ApiError.conflict('A shipment already exists for this order.');
    const created = await createShiprocketOrder(order);
    order.shipment.provider = 'shiprocket';
    order.shipment.orderId = String(created.order_id);
    order.shipment.shipmentId = String(created.shipment_id);
    order.shipment.createdAt = new Date();
    order.notes.push({ by: req.admin!.name, text: 'Shiprocket shipment created.', at: new Date() });
    if (order.status === 'confirmed') {
      order.status = 'packed';
      stampTimeline(order, 'packed');
    }
    await order.save();
    res.json({ ok: true, order });
  }),
);

adminOrdersRouter.post(
  '/:id/awb',
  requirePermission('fulfilment.awb'),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order?.shipment.shipmentId) throw ApiError.badRequest('Create the shipment first.');
    const result = await assignAwb(order.shipment.shipmentId);
    const data = result.response?.data;
    if (!data?.awb_code) throw ApiError.badRequest('Shiprocket did not return an AWB — try again shortly.');
    order.shipment.awb = data.awb_code;
    order.shipment.courier = data.courier_name ?? '';
    order.trackingNumber = data.awb_code;
    order.courier = data.courier_name ?? '';
    await order.save();
    res.json({ ok: true, order });
  }),
);

adminOrdersRouter.post(
  '/:id/pickup',
  requirePermission('fulfilment.pickup'),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order?.shipment.shipmentId) throw ApiError.badRequest('Create the shipment first.');
    await requestPickup(order.shipment.shipmentId);
    order.shipment.pickupRequestedAt = new Date();
    await order.save();
    res.json({ ok: true, order });
  }),
);

adminOrdersRouter.post(
  '/:id/label',
  requirePermission('fulfilment.label'),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order?.shipment.shipmentId) throw ApiError.badRequest('Create the shipment first.');
    const result = await generateLabel(order.shipment.shipmentId);
    if (result.label_url) {
      order.shipment.labelUrl = result.label_url;
      await order.save();
    }
    res.json({ ok: true, labelUrl: result.label_url ?? order.shipment.labelUrl });
  }),
);

adminOrdersRouter.post(
  '/:id/shiprocket-invoice',
  requirePermission('fulfilment.invoice'),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order?.shipment.orderId) throw ApiError.badRequest('Create the shipment first.');
    const result = await generateShiprocketInvoice(order.shipment.orderId);
    if (result.invoice_url) {
      order.shipment.invoiceUrl = result.invoice_url;
      await order.save();
    }
    res.json({ ok: true, invoiceUrl: result.invoice_url ?? order.shipment.invoiceUrl });
  }),
);

adminOrdersRouter.post(
  '/:id/track',
  requirePermission('fulfilment.track'),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order?.shipment.awb) throw ApiError.badRequest('No AWB on this order yet.');
    const info = await trackAwb(order.shipment.awb);
    const current = info.tracking_data?.shipment_track?.[0]?.current_status?.toUpperCase() ?? '';
    order.shipment.status = current;
    order.shipment.lastSyncedAt = new Date();
    const mapped = TRACK_TO_STATUS[current] as OrderStatus | undefined;
    if (mapped && mapped !== order.status) {
      order.notes.push({ by: req.admin!.name, text: `Tracking sync: ${current}.`, at: new Date() });
      await applyStatusChange(order, mapped);
    } else {
      await order.save();
    }
    res.json({ ok: true, order, courierStatus: current || 'No update yet' });
  }),
);

adminOrdersRouter.post(
  '/:id/cancel-shipment',
  requirePermission('fulfilment.cancel'),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order?.shipment.orderId) throw ApiError.badRequest('No shipment to cancel.');
    await cancelShiprocketOrder(order.shipment.orderId);
    order.shipment = {
      provider: '',
      shipmentId: '',
      orderId: '',
      awb: '',
      courier: '',
      status: '',
      createdAt: null,
      pickupRequestedAt: null,
      labelUrl: '',
      invoiceUrl: '',
      lastSyncedAt: null,
    };
    order.courier = '';
    order.trackingNumber = '';
    order.notes.push({ by: req.admin!.name, text: 'Shipment cancelled.', at: new Date() });
    await order.save();
    res.json({ ok: true, order });
  }),
);

adminOrdersRouter.post(
  '/:id/manual-tracking',
  requirePermission('fulfilment.manual'),
  validateBody(z.object({ courier: z.string().trim().min(1), awb: z.string().trim().min(3) })),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw ApiError.notFound('Order not found.');
    order.courier = req.body.courier;
    order.trackingNumber = req.body.awb;
    if (!order.shipment.provider) order.shipment.provider = 'manual';
    if (!order.shipment.createdAt) order.shipment.createdAt = new Date();
    order.shipment.awb = req.body.awb;
    order.shipment.courier = req.body.courier;
    order.notes.push({ by: req.admin!.name, text: `Manual tracking: ${req.body.courier} ${req.body.awb}.`, at: new Date() });
    await order.save();
    res.json({ ok: true, order });
  }),
);

/* ------------------------------------------------------------ invoice data */
adminOrdersRouter.get(
  '/:id/invoice',
  requirePermission('orders.invoice'),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw ApiError.notFound('Order not found.');
    if (!order.invoiceNo) {
      order.invoiceNo = await nextInvoiceNumber();
      await order.save();
    }
    res.json({ ok: true, order });
  }),
);

/**
 * The invoice, rendered server-side — the panel's view/print and PDF proxy
 * this so every surface shows the same document. Minting the invoice number
 * here (when a paid order somehow lacks one) keeps the sequence in ONE
 * counter instead of letting a client count rows.
 */
adminOrdersRouter.get(
  '/:id/invoice',
  requirePermission('orders.invoice'),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw ApiError.notFound('Order not found.');
    if (!order.invoiceNo && order.paymentStatus === 'paid') {
      order.invoiceNo = await nextInvoiceNumber();
      await order.save();
    }
    const html = await renderInvoiceHtml(order, { toolbar: req.query.print !== '0' });
    res.type('html').send(html);
  }),
);
