import { env, productionConfigWarnings, CASHFREE_WEBHOOK_PATH, SHIPROCKET_WEBHOOK_PATH } from './config/env';
import { connectDb } from './db/connect';
import { createApp } from './app';
import { startSyncWorker } from './services/syncing';
import { startBackupWorker } from './services/backup';

async function main() {
  await connectDb();
  const app = createApp();
  app.listen(env.port, () => {
    console.log(`[server] 10X API on http://localhost:${env.port} (${env.nodeEnv})`);
    const base = env.publicApiUrl || `http://localhost:${env.port}`;
    console.log(`[server] Cashfree ${env.cashfree.env} — webhook URL: POST ${base}${CASHFREE_WEBHOOK_PATH}`);
    console.log(`[server] Shiprocket webhook URL: POST ${base}${SHIPROCKET_WEBHOOK_PATH}`);
    for (const warning of productionConfigWarnings()) console.warn(`[server] CONFIG WARNING: ${warning}`);
  });
  startSyncWorker();
  startBackupWorker();
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
