import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { CustomerQuery, QUERY_TOPICS } from '../../models/Query';
import { Customer } from '../../models/Customer';
import { nextQueryReference } from '../../models/Counter';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requireCustomer } from '../../middleware/customerAuth';
import { emails } from '../../services/emails';
import { logEvent } from '../../models/Event';

export const queriesRouter = Router();

// Queries come only from signed-in customers now, so the form needs no name,
// email or phone — the account already knows all three. Signed-in also means
// no honeypot: bots don't have sessions.
const queryLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 6, standardHeaders: true, legacyHeaders: false });

/** 'callback' is raised only by the order-help chat, never typed by hand. */
const ASKABLE_TOPICS = QUERY_TOPICS.filter((t) => t !== 'callback');

queriesRouter.post(
  '/me/queries',
  queryLimiter,
  requireCustomer,
  validateBody(
    z.object({
      topic: z.enum(ASKABLE_TOPICS as [string, ...string[]], { errorMap: () => ({ message: 'Pick the closest topic.' }) }),
      message: z.string().trim().min(15, 'A little more detail helps us answer properly.').max(4000),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.body as { topic: (typeof QUERY_TOPICS)[number]; message: string };
    const customer = await Customer.findById(req.customer!.id);

    const reference = await nextQueryReference();
    const created = await CustomerQuery.create({
      reference,
      topic: body.topic,
      name: req.customer!.name,
      email: req.customer!.email,
      phone: customer?.phone ?? '',
      orderReference: '',
      message: body.message,
      status: 'new',
    });

    await logEvent('query', `New query ${reference}`, `${req.customer!.name} — ${body.topic}`, `/queries/${created.id}`);

    // Fire-safe: a mail provider outage must not lose the question.
    await emails.queryReceived({
      email: req.customer!.email,
      name: req.customer!.name,
      reference,
      message: body.message,
    });

    res.status(201).json({ ok: true, reference, firstName: req.customer!.name.split(' ')[0] });
  }),
);
