import { Router } from 'express';
import { BackupRecord } from '../../models/BackupRecord';
import { runBackup, backupBuckets } from '../../services/backup';
import { isS3Configured } from '../../services/s3';
import { env } from '../../config/env';
import { asyncHandler } from '../../utils/asyncHandler';
import { requireAdminPermission } from '../../middleware/adminPermission';

// Backup status and manual runs are available only to the authenticated admin.

export const adminBackupsRouter = Router();

adminBackupsRouter.get(
  '/',
  requireAdminPermission('settings.backups'),
  asyncHandler(async (_req, res) => {
    const [records, enabled, hour, retention, buckets, s3Ready] = await Promise.all([
      BackupRecord.find().sort({ startedAt: -1 }).limit(20),
      Promise.resolve(env.backup.enabled),
      Promise.resolve(env.backup.hourIst),
      Promise.resolve(env.backup.retentionDays),
      backupBuckets(),
      isS3Configured(),
    ]);
    const lastSuccess = records.find((r) => r.status === 'success' || r.status === 'partial');
    res.json({
      ok: true,
      config: {
        enabled,
        hourIst: hour || 3,
        retentionDays: retention || 30,
        buckets,
        s3Ready,
      },
      lastSuccessAt: lastSuccess?.startedAt ?? null,
      records: records.map((r) => ({
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        sizeBytes: r.sizeBytes,
        collectionCount: r.collectionCount,
        documentCount: r.documentCount,
        destinations: r.destinations,
        prunedCount: r.prunedCount,
        error: r.error,
        by: r.by,
      })),
    });
  }),
);

adminBackupsRouter.post(
  '/run',
  requireAdminPermission('settings.backups'),
  asyncHandler(async (req, res) => {
    const result = await runBackup('manual', req.admin?.name ?? 'Admin');
    res.json(result);
  }),
);
