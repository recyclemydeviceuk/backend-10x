import { Router } from 'express';
import { z } from 'zod';
import { getSettings } from '../../models/Setting';
import { Signup } from '../../models/Signup';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { testCashfreeConnection, isCashfreeConfigured, cashfreeMode } from '../../services/cashfree';
import { testShiprocketConnection, isShiprocketConfigured, getPickupLocation } from '../../services/shiprocket';
import { runSync } from '../../services/syncing';
import { env } from '../../config/env';

export const adminSettingsRouter = Router();

adminSettingsRouter.get(
  '/',
  requirePermission('settings.view'),
  asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    res.json({
      ok: true,
      settings: {
        store: settings.store,
        warehouse: settings.warehouse,
        syncing: {
          autoShipments: settings.automation.autoShipments,
          autoApproveReturns: settings.automation.autoApproveReturns,
          lastRunAt: settings.automation.lastRunAt,
          log: settings.automation.log.slice(0, 10),
        },
      },
      integrations: {
        cashfree: { configured: await isCashfreeConfigured(), mode: await cashfreeMode() },
        shiprocket: {
          configured: await isShiprocketConfigured(),
          pickupLocation: env.shiprocket.pickupLocation,
          // The warehouse as Shiprocket has it — managed there, shown here.
          pickup: await getPickupLocation(),
        },
        s3: { configured: Boolean(env.s3.bucket), bucket: env.s3.bucket },
        email: {
          provider: 'ses',
          configured: Boolean(env.ses.accessKeyId && env.ses.fromEmail),
          sender: env.ses.fromEmail,
        },
      },
    });
  }),
);

/** Store identity, support contacts and cash-on-delivery. The warehouse lives in Shiprocket. */
adminSettingsRouter.patch(
  '/store',
  requirePermission('settings.delivery'),
  validateBody(
    z.object({
      name: z.string().trim().min(1).max(80).optional(),
      supportEmail: z.string().trim().email().optional(),
      supportPhone: z.string().trim().max(20).optional(),
      codEnabled: z.boolean().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    if (req.body.name !== undefined) settings.store.name = req.body.name;
    if (req.body.supportEmail !== undefined) settings.store.supportEmail = req.body.supportEmail;
    if (req.body.supportPhone !== undefined) settings.store.supportPhone = req.body.supportPhone;
    if (req.body.codEnabled !== undefined) settings.store.codEnabled = req.body.codEnabled;
    await settings.save();
    res.json({ ok: true, store: settings.store });
  }),
);

/** The only syncing switch: auto-book a courier for every paid / COD order. */
adminSettingsRouter.patch(
  '/syncing',
  requirePermission('settings.syncing'),
  validateBody(z.object({ autoShipments: z.boolean().optional(), autoApproveReturns: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    if (req.body.autoShipments !== undefined) settings.automation.autoShipments = req.body.autoShipments;
    if (req.body.autoApproveReturns !== undefined) settings.automation.autoApproveReturns = req.body.autoApproveReturns;
    await settings.save();
    res.json({
      ok: true,
      syncing: { autoShipments: settings.automation.autoShipments, autoApproveReturns: settings.automation.autoApproveReturns },
    });
  }),
);

/**
 * Subscription rules: the delivery cadence and the auto-pay nudge loop.
 * Reminders go out every `autopayReminderEveryDays` (0 switches them off),
 * at most `autopayReminderMax` per plan, and stop the moment a customer
 * enables auto-pay or says "I'll pay on delivery".
 */
adminSettingsRouter.patch(
  '/subscriptions',
  requirePermission('settings.delivery'),
  validateBody(
    z.object({
      subscriptionIntervalDays: z.number().int().min(7).max(90).optional(),
      autopayReminderEveryDays: z.number().int().min(0).max(30).optional(),
      autopayReminderMax: z.number().int().min(0).max(20).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    if (req.body.subscriptionIntervalDays !== undefined) settings.store.subscriptionIntervalDays = req.body.subscriptionIntervalDays;
    if (req.body.autopayReminderEveryDays !== undefined) settings.store.autopayReminderEveryDays = req.body.autopayReminderEveryDays;
    if (req.body.autopayReminderMax !== undefined) settings.store.autopayReminderMax = req.body.autopayReminderMax;
    await settings.save();
    res.json({
      ok: true,
      subscriptions: {
        subscriptionIntervalDays: settings.store.subscriptionIntervalDays,
        autopayReminderEveryDays: settings.store.autopayReminderEveryDays,
        autopayReminderMax: settings.store.autopayReminderMax,
      },
    });
  }),
);

/**
 * Delivery charges — the one store rule with its own switch. 'free' waives
 * the fee on every order; 'priced' charges the flat fee under the threshold.
 * The checkout reads these on every order, the storefront within seconds.
 */
adminSettingsRouter.patch(
  '/delivery',
  requirePermission('settings.delivery'),
  validateBody(
    z.object({
      deliveryMode: z.enum(['free', 'priced', 'live']),
      flatShipping: z.number().min(0).max(100000).optional(),
      freeShippingOver: z.number().min(0).max(1000000).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    settings.store.deliveryMode = req.body.deliveryMode;
    if (req.body.flatShipping !== undefined) settings.store.flatShipping = req.body.flatShipping;
    if (req.body.freeShippingOver !== undefined) settings.store.freeShippingOver = req.body.freeShippingOver;
    await settings.save();
    res.json({
      ok: true,
      message: settings.store.deliveryMode === 'live'
        ? `Live Shiprocket rates${settings.store.freeShippingOver > 0 ? `, free over ₹${settings.store.freeShippingOver}` : ''}; ₹${settings.store.flatShipping} if Shiprocket can't quote.`
        : settings.store.deliveryMode === 'free'
        ? 'Delivery is free on every order now.'
        : `Delivery charges ₹${settings.store.flatShipping} under ₹${settings.store.freeShippingOver}.`,
      delivery: {
        deliveryMode: settings.store.deliveryMode,
        flatShipping: settings.store.flatShipping,
        freeShippingOver: settings.store.freeShippingOver,
      },
    });
  }),
);

/**
 * The launch switch. ON = the storefront's middleware sends every page to the
 * coming-soon screen (legal pages stay reachable); OFF = the shop is live.
 * The storefront notices within its settings cache window (~15s).
 */
adminSettingsRouter.patch(
  '/coming-soon',
  requirePermission('settings.maintenance'),
  validateBody(z.object({ enabled: z.boolean() })),
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    settings.store.comingSoonMode = req.body.enabled;
    await settings.save();
    res.json({
      ok: true,
      message: req.body.enabled
        ? 'Coming-soon mode is ON — the storefront now shows only the launch page.'
        : 'The storefront is LIVE again.',
      comingSoonMode: settings.store.comingSoonMode,
    });
  }),
);

/** Early-access emails collected by the coming-soon page, newest first. */
adminSettingsRouter.get(
  '/signups',
  requirePermission('settings.maintenance'),
  asyncHandler(async (_req, res) => {
    const signups = await Signup.find().sort({ createdAt: -1 }).limit(1000);
    res.json({
      ok: true,
      total: await Signup.countDocuments(),
      signups: signups.map((row) => ({ id: row.id, email: row.email, at: row.createdAt })),
    });
  }),
);

adminSettingsRouter.post(
  '/test/cashfree',
  requirePermission('settings.view'),
  asyncHandler(async (_req, res) => res.json(await testCashfreeConnection())),
);

adminSettingsRouter.post(
  '/test/shiprocket',
  requirePermission('settings.view'),
  asyncHandler(async (_req, res) => res.json(await testShiprocketConnection())),
);

adminSettingsRouter.post(
  '/sync/run',
  requirePermission('settings.syncing'),
  asyncHandler(async (_req, res) => {
    const result = await runSync(true);
    res.json({
      ok: true,
      message:
        result.actions.length > 0
          ? `Sync ran: ${result.actions.slice(0, 3).join(' · ')}${result.actions.length > 3 ? ` (+${result.actions.length - 3} more)` : ''}`
          : 'Sync ran — everything is already up to date.',
      actions: result.actions,
    });
  }),
);
