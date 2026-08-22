import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error';
import { requireAdmin } from './middleware/adminAuth';
import { asyncHandler } from './utils/asyncHandler';
import { runSync } from './services/syncing';

// public
import { authRouter } from './routes/public/auth';
import { catalogRouter } from './routes/public/catalog';
import { checkoutRouter } from './routes/public/checkout';
import { myOrdersRouter } from './routes/public/orders';
import { myReturnsRouter } from './routes/public/returns';
import { mySubscriptionsRouter } from './routes/public/subscriptions';
import { queriesRouter } from './routes/public/queries';
import { devTestPaymentRouter } from './routes/dev/testPayment';
import { cartRouter } from './routes/public/cart';
// webhooks
import { webhooksRouter } from './routes/webhooks';
// admin
import { adminAuthRouter } from './routes/admin/auth';
import { adminFaceLockRouter } from './routes/admin/faceLock';
import { adminOrdersRouter } from './routes/admin/orders';
import { adminCustomersRouter } from './routes/admin/customers';
import { adminProductsRouter } from './routes/admin/products';
import { adminCouponsRouter } from './routes/admin/coupons';
import { adminSubscriptionsRouter } from './routes/admin/subscriptions';
import { adminReturnsRouter } from './routes/admin/returns';
import { adminSettingsRouter } from './routes/admin/settings';
import { adminMetricsRouter } from './routes/admin/metrics';
import { adminMiscRouter } from './routes/admin/misc';
import { adminBackupsRouter } from './routes/admin/backups';
import { adminCollectionsRouter } from './routes/admin/collections';
import { adminQueriesRouter } from './routes/admin/queries';
import { adminMediaRouter } from './routes/admin/media';
import { adminProfileRouter } from './routes/admin/profile';
import { adminTeamRouter } from './routes/admin/team';
import { adminRolesRouter } from './routes/admin/roles';

export function createApp(): express.Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      allowedHeaders: ['content-type', 'authorization', 'x-sync-key'],
    }),
  );
  app.use(morgan(env.isProd ? 'combined' : 'dev'));

  // Cross-site request forgery guard for cookie sessions. Production cookies
  // are SameSite=None (the storefront and API are different origins), so a
  // form on another site could post with the customer's cookie. JSON calls
  // are stopped by the CORS preflight; multipart and bodiless POSTs are
  // not — so every state-changing request must come from one of our origins.
  // Webhooks and server-to-server calls carry no Origin and pass.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    if (env.corsOrigins.includes(origin)) return next();
    return res.status(403).json({ ok: false, message: 'Cross-site request refused.' });
  });

  // Webhooks first — the Cashfree route needs the RAW body for signatures.
  app.use('/api/v1/webhooks', webhooksRouter);

  app.use(express.json({ limit: '25mb' }));
  app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: '10x-server', at: new Date().toISOString() }));

  /* -------------------------------------------------------------- public */
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1', catalogRouter);
  app.use('/api/v1', checkoutRouter);
  app.use('/api/v1', queriesRouter);

  // Local-only: settle a checkout without a card. Two conditions must hold, so
  // it cannot be switched on by accident in a deployed environment.
  if (process.env.ALLOW_TEST_PAYMENTS === 'true' && !env.isProd) {
    // eslint-disable-next-line no-console
    console.warn('[dev] TEST PAYMENTS ENABLED — POST /api/v1/dev/test-payment/:reference creates paid orders without money.');
    app.use('/api/v1/dev', devTestPaymentRouter);
  }
  app.use('/api/v1', cartRouter);
  app.use('/api/v1/me', myOrdersRouter);
  app.use('/api/v1/me', myReturnsRouter);
  app.use('/api/v1/me', mySubscriptionsRouter);

  /* --------------------------------------------------------------- admin */
  app.use('/api/v1/admin/auth', adminAuthRouter);
  // Face lock mounts beside auth — its /login is public, the rest per-route requireAdmin.
  app.use('/api/v1/admin/auth/face', adminFaceLockRouter);

  // Optional external cron entry guarded by the environment-only sync key.
  app.post(
    '/api/v1/internal/sync/run',
    asyncHandler(async (req, res, next) => {
      const key = String(req.headers['x-sync-key'] ?? '');
      const expected = env.syncKey;
      if (expected && key === expected) {
        const result = await runSync(true);
        return res.json({ ok: true, actions: result.actions });
      }
      next();
    }),
  );

  // These routes apply their own fine-grained admin permissions.
  app.use('/api/v1/admin/backups', adminBackupsRouter);
  app.use('/api/v1/admin/collections', adminCollectionsRouter);
  app.use('/api/v1/admin/queries', adminQueriesRouter);
  app.use('/api/v1/admin/media', adminMediaRouter);
  app.use('/api/v1/admin/profile', adminProfileRouter);

  const admin = express.Router();
  admin.use(requireAdmin);
  admin.use('/orders', adminOrdersRouter);
  admin.use('/customers', adminCustomersRouter);
  admin.use('/products', adminProductsRouter);
  admin.use('/coupons', adminCouponsRouter);
  admin.use('/subscriptions', adminSubscriptionsRouter);
  admin.use('/returns', adminReturnsRouter);
  admin.use('/settings', adminSettingsRouter);
  admin.use('/team', adminTeamRouter);
  admin.use('/roles', adminRolesRouter);
  admin.use('/metrics', adminMetricsRouter);
  admin.use('/', adminMiscRouter);
  app.use('/api/v1/admin', admin);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
