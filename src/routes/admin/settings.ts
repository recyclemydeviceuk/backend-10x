import { Router } from 'express';
import { z } from 'zod';
import { getSettings } from '../../models/Setting';
import { Signup } from '../../models/Signup';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { testCashfreeConnection, isCashfreeConfigured, cashfreeMode } from '../../services/cashfree';
import { testShiprocketConnection, isShiprocketConfigured } from '../../services/shiprocket';
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
          autoTrackingSync: settings.automation.autoTrackingSync,
          autoPaymentSync: settings.automation.autoPaymentSync,
          autoSubscriptionCycles: settings.automation.autoSubscriptionCycles,
          lastRunAt: settings.automation.lastRunAt,
          log: settings.automation.log.slice(0, 10),
        },
      },
      integrations: {
        cashfree: { configured: await isCashfreeConfigured(), mode: await cashfreeMode() },
        shiprocket: {
          configured: await isShiprocketConfigured(),
          pickupLocation: env.shiprocket.pickupLocation,
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
      deliveryMode: z.enum(['free', 'priced']),
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
      message: settings.store.deliveryMode === 'free'
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
