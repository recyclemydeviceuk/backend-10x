import mongoose from 'mongoose';
import zlib from 'zlib';
import { EJSON } from 'bson';
import { BackupRecord } from '../models/BackupRecord';
import { putObject, listKeys, deleteObject, isS3Configured } from './s3';
import { env } from '../config/env';

// =========================================================
// Daily database backups.
//
// Dumps EVERY collection to one gzipped EJSON archive
// (type-faithful — ObjectIds and Dates survive a restore)
// and uploads it to up to three S3 buckets, then prunes
// archives older than the retention window in each bucket.
//
// Configuration is environment-only; the panel can inspect status and run a
// manual backup but cannot read or alter credentials or scheduling keys.
// =========================================================

const PREFIX = 'backups/';

/** Up to three destination buckets; blank config = the main media bucket. */
export async function backupBuckets(): Promise<string[]> {
  const raw = env.backup.buckets;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (list.length > 0) return list;
  const main = env.s3.bucket;
  return main ? [main] : [];
}

async function buildArchive(): Promise<{ body: Buffer; collections: number; documents: number }> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection.');
  const collections = await db.collections();

  const dump: Record<string, unknown[]> = {};
  let documents = 0;
  for (const collection of collections) {
    if (collection.collectionName.startsWith('system.')) continue;
    const docs = await collection.find({}).toArray();
    dump[collection.collectionName] = docs;
    documents += docs.length;
  }

  const payload = {
    version: 1,
    at: new Date().toISOString(),
    db: db.databaseName,
    collections: dump,
  };
  // Canonical EJSON keeps ObjectId/Date/Decimal types restorable.
  const body = zlib.gzipSync(Buffer.from(EJSON.stringify(payload, { relaxed: false })), { level: 9 });
  return { body, collections: Object.keys(dump).length, documents };
}

async function prune(bucket: string, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 86400_000;
  let pruned = 0;
  const keys = await listKeys(bucket, PREFIX);
  for (const item of keys) {
    if (item.lastModified && item.lastModified.getTime() < cutoff) {
      await deleteObject(bucket, item.key);
      pruned++;
    }
  }
  return pruned;
}

export async function runBackup(trigger: 'schedule' | 'manual', by = ''): Promise<{
  ok: boolean;
  message: string;
  recordId?: string;
}> {
  const startedAt = new Date();

  if (!(await isS3Configured())) {
    await BackupRecord.create({
      status: 'failed',
      trigger,
      startedAt,
      by,
      error: 'S3 is not configured on the backend.',
    });
    return { ok: false, message: 'S3 is not configured on the backend.' };
  }
  const buckets = await backupBuckets();
  if (buckets.length === 0) {
    await BackupRecord.create({
      status: 'failed',
      trigger,
      startedAt,
      by,
      error: 'No backup bucket — set BACKUP_S3_BUCKETS or S3_BUCKET.',
    });
    return { ok: false, message: 'No backup bucket — set BACKUP_S3_BUCKETS or S3_BUCKET.' };
  }

  try {
    const { body, collections, documents } = await buildArchive();
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const key = `${PREFIX}10x-backup-${stamp}.ejson.gz`;

    const destinations: { bucket: string; key: string; ok: boolean; error: string }[] = [];
    for (const bucket of buckets) {
      try {
        await putObject(bucket, key, body, 'application/gzip');
        destinations.push({ bucket, key, ok: true, error: '' });
      } catch (err) {
        destinations.push({ bucket, key, ok: false, error: err instanceof Error ? err.message : 'upload failed' });
      }
    }

    // Retention sweep — only in buckets that accepted the new archive.
    const retentionDays = env.backup.retentionDays;
    let prunedCount = 0;
    for (const dest of destinations.filter((d) => d.ok)) {
      try {
        prunedCount += await prune(dest.bucket, retentionDays);
      } catch {
        /* pruning is best-effort */
      }
    }

    const okCount = destinations.filter((d) => d.ok).length;
    const status = okCount === destinations.length ? 'success' : okCount > 0 ? 'partial' : 'failed';
    const record = await BackupRecord.create({
      status,
      trigger,
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
      sizeBytes: body.length,
      collectionCount: collections,
      documentCount: documents,
      destinations,
      prunedCount,
      by,
      error: status === 'failed' ? destinations.map((d) => d.error).filter(Boolean).join(' · ') : '',
    });

    const mb = (body.length / 1024 / 1024).toFixed(2);
    return {
      ok: status !== 'failed',
      message:
        status === 'success'
          ? `Backed up ${documents} documents (${mb} MB) to ${okCount} bucket${okCount === 1 ? '' : 's'}.`
          : status === 'partial'
            ? `Backed up to ${okCount} of ${destinations.length} buckets — check the failed one.`
            : `Backup failed: ${destinations.map((d) => d.error).filter(Boolean).join(' · ')}`,
      recordId: record.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Backup failed.';
    await BackupRecord.create({
      status: 'failed',
      trigger,
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
      by,
      error: message,
    });
    return { ok: false, message };
  }
}

/* -------------------------------------------------------------- schedule */

function istHour(date = new Date()): number {
  return Number(date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }));
}

function istDayStamp(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** True when a scheduled backup already succeeded today (IST). */
async function ranToday(): Promise<boolean> {
  const latest = await BackupRecord.findOne({ status: { $in: ['success', 'partial'] } }).sort({ startedAt: -1 });
  if (!latest) return false;
  return istDayStamp(latest.startedAt) === istDayStamp(new Date());
}

/**
 * Checks every 10 minutes and fires once a day at the environment-configured
 * IST hour.
 */
export function startBackupWorker(): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      if (!env.backup.enabled) return;
      const hour = env.backup.hourIst || 3;
      if (istHour() !== hour) return;
      if (await ranToday()) return;
      const result = await runBackup('schedule');
      console.log(`[backup] scheduled run: ${result.message}`);
    } catch (err) {
      console.error('[backup] worker error:', err);
    }
  }, 10 * 60_000);
  timer.unref();
  console.log('[backup] worker armed (checks every 10 min)');
  return timer;
}
