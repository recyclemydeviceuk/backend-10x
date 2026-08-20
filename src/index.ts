import { env } from './config/env';
import { connectDb } from './db/connect';
import { createApp } from './app';
import { startSyncWorker } from './services/syncing';
import { startBackupWorker } from './services/backup';

async function main() {
  await connectDb();
  const app = createApp();
  app.listen(env.port, () => {
    console.log(`[server] 10X API on http://localhost:${env.port} (${env.nodeEnv})`);
  });
  startSyncWorker();
  startBackupWorker();
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
