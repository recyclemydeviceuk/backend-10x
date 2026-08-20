import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Order } from '../../models/Order';
import { ReturnRequest } from '../../models/ReturnRequest';
import { nextReturnReference } from '../../models/Counter';
import { logEvent } from '../../models/Event';
import { asyncHandler } from '../../utils/asyncHandler';
import { requireCustomer } from '../../middleware/customerAuth';
import { ApiError } from '../../utils/ApiError';
import { uploadMedia } from '../../services/s3';
import { emails } from '../../services/emails';

export const myReturnsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 4 },
});

const RETURN_WINDOW_DAYS = 7;

/** File a return: delivered order, within the window, one open return per order. */
myReturnsRouter.post(
  '/returns',
  requireCustomer,
  upload.array('photos', 4),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        orderReference: z.string().trim().min(1),
        reason: z.string().trim().min(3),
        description: z.string().trim().min(20, 'Describe the problem in at least 20 characters.'),
      })
      .parse(req.body);

    const order = await Order.findOne({ reference: parsed.orderReference, customerId: req.customer!.id });
    if (!order) throw ApiError.notFound('Order not found.');
    if (order.status !== 'delivered') throw ApiError.badRequest('Returns open once the order is delivered.');

    const deliveredAt = order.timeline.find((t) => t.stage === 'delivered')?.at ?? order.placedAt;
    if (Date.now() - new Date(deliveredAt).getTime() > RETURN_WINDOW_DAYS * 86400_000) {
      throw ApiError.badRequest(`Returns close ${RETURN_WINDOW_DAYS} days after delivery.`);
    }
    const open = await ReturnRequest.findOne({
      orderId: order.id,
      status: { $in: ['requested', 'approved', 'received'] },
    });
    if (open) throw ApiError.conflict(`A return (${open.reference}) is already in progress for this order.`);

    const photos: string[] = [];
    for (const file of (req.files as Express.Multer.File[] | undefined) ?? []) {
      photos.push(await uploadMedia(file, 'returns'));
    }

    const reference = await nextReturnReference();
    const ret = await ReturnRequest.create({
      reference,
      orderId: order.id,
      orderReference: order.reference,
      customerId: order.customerId,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      reason: parsed.reason,
      description: parsed.description,
      photos,
      amount: order.total,
      isPrepaid: order.paymentMethod === 'online',
      status: 'requested',
      timeline: [{ stage: 'requested', at: new Date() }],
    });

    await logEvent('return', `Return requested ${reference}`, `${order.customerName} — ${order.reference}`, `/returns/${ret.id}`);
    await emails.returnUpdate({
      email: ret.customerEmail,
      name: ret.customerName,
      reference,
      orderReference: order.reference,
      status: 'requested',
      amount: ret.amount,
    });

    res.status(201).json({ ok: true, return: { reference, status: ret.status } });
  }),
);

myReturnsRouter.get(
  '/returns',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const returns = await ReturnRequest.find({ customerId: req.customer!.id }).sort({ createdAt: -1 });
    res.json({
      ok: true,
      returns: returns.map((r) => ({
        reference: r.reference,
        orderReference: r.orderReference,
        reason: r.reason,
        status: r.status,
        rejectReason: r.rejectReason,
        amount: r.amount,
        timeline: r.timeline,
        createdAt: r.createdAt,
      })),
    });
  }),
);
