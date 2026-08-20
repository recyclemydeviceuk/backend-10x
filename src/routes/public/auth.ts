import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { Customer } from '../../models/Customer';
import { hashPassword, verifyPassword, randomToken } from '../../utils/crypto';
import { signCustomerToken } from '../../utils/jwt';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requireCustomer } from '../../middleware/customerAuth';
import { ApiError } from '../../utils/ApiError';
import { logEvent } from '../../models/Event';
import { emails } from '../../services/emails';
import multer from 'multer';
import { clearCustomerSession, setCustomerSession } from '../../utils/customerSession';
import { deleteMedia, uploadMedia } from '../../services/s3';
import { claimCartForCustomer } from '../../services/cartSession';

export const authRouter = Router();

const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

const customerView = (c: InstanceType<typeof Customer>) => ({
  id: c.id,
  name: c.name,
  email: c.email,
  phone: c.phone,
  avatarUrl: c.avatarUrl,
  addresses: c.addresses,
  marketingOptIn: c.marketingOptIn,
  joinedAt: (c as unknown as { createdAt?: Date }).createdAt ?? new Date(),
  hasSubscription: c.hasSubscription,
});

/* --------------------------------------------------------------- register */
authRouter.post(
  '/register',
  authLimiter,
  validateBody(
    z.object({
      name: z.string().trim().min(2, 'Tell us your name.'),
      email: z.string().trim().toLowerCase().email('That email does not look right.'),
      password: z.string().min(8, 'Password needs at least 8 characters.'),
      phone: z.string().trim().optional().default(''),
      marketingOptIn: z.boolean().optional().default(false),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { name, email, password, phone, marketingOptIn } = req.body;
    const existing = await Customer.findOne({ email });
    if (existing && existing.passwordHash) throw ApiError.conflict('That email already has an account — sign in instead.');

    // Admin-created customers (no password yet) claim their account here.
    const customer =
      existing ??
      new Customer({ name, email, phone, marketingOptIn, lastActiveAt: new Date() });
    customer.passwordHash = hashPassword(password);
    if (!customer.name) customer.name = name;
    await customer.save();

    if (!existing) await logEvent('customer', `New customer ${name}`, email, `/customers/${customer.id}`);
    const token = signCustomerToken(customer.id);
    setCustomerSession(res, token);
    await claimCartForCustomer(req, customer.id);
    res.status(201).json({ ok: true, token, customer: customerView(customer) });
  }),
);

/* ------------------------------------------------------------------ login */
authRouter.post(
  '/login',
  authLimiter,
  validateBody(
    z.object({
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(1),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const customer = await Customer.findOne({ email });
    if (!customer || !customer.passwordHash || !verifyPassword(password, customer.passwordHash)) {
      throw ApiError.unauthorized('That email and password don’t match.');
    }
    customer.lastActiveAt = new Date();
    await customer.save();
    const token = signCustomerToken(customer.id);
    setCustomerSession(res, token);
    await claimCartForCustomer(req, customer.id);
    res.json({ ok: true, token, customer: customerView(customer) });
  }),
);

authRouter.post('/logout', (_req, res) => {
  clearCustomerSession(res);
  res.json({ ok: true });
});

/* --------------------------------------------------------------------- me */
authRouter.get(
  '/me',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.customer!.id);
    if (!customer) throw ApiError.unauthorized();
    res.json({ ok: true, customer: customerView(customer) });
  }),
);

/* ---------------------------------------------------------------- profile */
authRouter.patch(
  '/me',
  requireCustomer,
  validateBody(
    z.object({
      name: z.string().trim().min(2).optional(),
      phone: z.string().trim().optional(),
      marketingOptIn: z.boolean().optional(),
      addresses: z
        .array(
          z.object({
            label: z.string().trim().default('Home'),
            fullName: z.string().trim().default(''),
            line1: z.string().trim().min(3),
            line2: z.string().trim().default(''),
            landmark: z.string().trim().default(''),
            city: z.string().trim().min(2),
            state: z.string().trim().min(2),
            pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits.'),
            phone: z.string().trim().default(''),
            isDefault: z.boolean().optional().default(false),
          }),
        )
        .max(5)
        .optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.customer!.id);
    if (!customer) throw ApiError.unauthorized();
    Object.assign(customer, req.body);
    if (req.body.addresses?.length) {
      // Exactly one default at any time — the first flagged one wins, and an
      // address book with none defaults to its first entry.
      const list = customer.addresses;
      const chosen = list.findIndex((a) => a.isDefault);
      const defaultIndex = chosen === -1 ? 0 : chosen;
      list.forEach((a, i) => {
        a.isDefault = i === defaultIndex;
      });
      customer.city = list[defaultIndex].city;
      customer.state = list[defaultIndex].state;
    }
    customer.lastActiveAt = new Date();
    await customer.save();
    res.json({ ok: true, customer: customerView(customer) });
  }),
);

const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

authRouter.post(
  '/me/avatar',
  requireCustomer,
  avatarUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Choose a profile photo.');
    const customer = await Customer.findById(req.customer!.id);
    if (!customer) throw ApiError.unauthorized();
    const previous = customer.avatarUrl;
    customer.avatarUrl = await uploadMedia(req.file, 'profiles');
    await customer.save();
    if (previous) void deleteMedia(previous);
    res.json({ ok: true, customer: customerView(customer) });
  }),
);

authRouter.delete(
  '/me/avatar',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.customer!.id);
    if (!customer) throw ApiError.unauthorized();
    const previous = customer.avatarUrl;
    customer.avatarUrl = '';
    await customer.save();
    if (previous) void deleteMedia(previous);
    res.json({ ok: true, customer: customerView(customer) });
  }),
);

/* ----------------------------------------------------------- email change */

/**
 * Moving an account to a new address.
 *
 * The code goes to the NEW address, not the old one. Proving control of the
 * inbox you are moving TO is the whole point; a code sent to the current
 * address proves nothing about the new one.
 */
authRouter.post(
  '/email/request',
  authLimiter,
  requireCustomer,
  validateBody(z.object({ email: z.string().trim().toLowerCase().email('That email does not look right.') })),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.customer!.id);
    if (!customer) throw ApiError.unauthorized();

    const email = req.body.email as string;
    if (email === customer.email) throw ApiError.badRequest('That is already your email address.');
    if (await Customer.findOne({ email })) throw ApiError.conflict('Another account already uses that email.');

    const code = String(Math.floor(100000 + Math.random() * 900000));
    customer.pendingEmail = email;
    customer.pendingEmailCodeHash = hashPassword(code);
    customer.pendingEmailExpires = new Date(Date.now() + 15 * 60_000);
    await customer.save();

    await emails.emailChangeCode({ email, name: customer.name, code });
    res.json({ ok: true, message: `We sent a six-digit code to ${email}.` });
  }),
);

authRouter.post(
  '/email/confirm',
  authLimiter,
  requireCustomer,
  validateBody(z.object({ email: z.string().trim().toLowerCase().email(), code: z.string().trim().length(6) })),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.customer!.id);
    if (!customer) throw ApiError.unauthorized();

    const expired = !customer.pendingEmailExpires || customer.pendingEmailExpires < new Date();
    const sameAddress = customer.pendingEmail === req.body.email;
    if (!customer.pendingEmail || expired || !sameAddress) {
      throw ApiError.badRequest('That code has expired — request a new one.');
    }
    if (!verifyPassword(req.body.code, customer.pendingEmailCodeHash)) {
      throw ApiError.badRequest('That code doesn’t match. Check and try again.');
    }
    // Last-moment re-check: someone else may have claimed the address while
    // this code was in flight.
    if (await Customer.findOne({ email: customer.pendingEmail })) {
      throw ApiError.conflict('Another account already uses that email.');
    }

    customer.email = customer.pendingEmail;
    customer.pendingEmail = '';
    customer.pendingEmailCodeHash = '';
    customer.pendingEmailExpires = null;
    await customer.save();

    res.json({ ok: true, customer: customerView(customer) });
  }),
);

/* -------------------------------------------------------- forgot password */
authRouter.post(
  '/forgot-password',
  authLimiter,
  validateBody(z.object({ email: z.string().trim().toLowerCase().email() })),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findOne({ email: req.body.email });
    // Same response either way — no account enumeration.
    if (customer && customer.passwordHash) {
      customer.passwordResetToken = randomToken();
      customer.passwordResetExpires = new Date(Date.now() + 60 * 60_000);
      await customer.save();
      await emails.passwordReset({ email: customer.email, name: customer.name, token: customer.passwordResetToken });
    }
    res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  validateBody(z.object({ token: z.string().min(10), password: z.string().min(8) })),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findOne({
      passwordResetToken: req.body.token,
      passwordResetExpires: { $gt: new Date() },
    });
    if (!customer) throw ApiError.badRequest('That reset link has expired — request a new one.');
    customer.passwordHash = hashPassword(req.body.password);
    customer.passwordResetToken = '';
    customer.passwordResetExpires = null;
    await customer.save();
    res.json({ ok: true, message: 'Password updated — sign in with the new one.' });
  }),
);

/* ------------------------------------------------------------------ cart */

/**
 * Mirror the storefront cart onto the account.
 *
 * Display only: the checkout prices every line from the catalogue, so nothing
 * stored here is ever charged. It exists so support can see what a customer is
 * looking at, and so the team can see what's being abandoned.
 */
authRouter.put(
  '/me/cart',
  requireCustomer,
  validateBody(
    z.object({
      items: z
        .array(
          z.object({
            productId: z.string().optional().default(''),
            tierId: z.string().optional().default(''),
            sku: z.string().optional().default(''),
            name: z.string().trim().min(1),
            packets: z.string().optional().default(''),
            quantity: z.number().int().min(1).max(20),
            price: z.number().min(0),
            isSubscription: z.boolean().optional().default(false),
          }),
        )
        .max(20),
    }),
  ),
  asyncHandler(async (req, res) => {
    const items = (req.body.items as Record<string, unknown>[]).map((i) => ({
      ...i,
      productId: /^[a-f\d]{24}$/i.test(String(i.productId)) ? i.productId : undefined,
    }));
    await Customer.updateOne(
      { _id: req.customer!.id },
      { $set: { cart: { items, updatedAt: new Date() }, lastActiveAt: new Date() } },
    );
    res.json({ ok: true });
  }),
);
