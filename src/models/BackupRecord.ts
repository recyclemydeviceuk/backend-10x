import { Schema, model } from 'mongoose';

// One document per backup run — success, partial (some buckets failed) or
// failed. Powers the history list in the panel's Backups tab.

const destinationSchema = new Schema(
  {
    bucket: { type: String, required: true },
    key: { type: String, default: '' },
    ok: { type: Boolean, required: true },
    error: { type: String, default: '' },
  },
  { _id: false },
);

const backupRecordSchema = new Schema(
  {
    status: { type: String, enum: ['success', 'partial', 'failed'], required: true },
    trigger: { type: String, enum: ['schedule', 'manual'], required: true },
    startedAt: { type: Date, required: true },
    durationMs: { type: Number, default: 0 },
    sizeBytes: { type: Number, default: 0 },
    collectionCount: { type: Number, default: 0 },
    documentCount: { type: Number, default: 0 },
    destinations: { type: [destinationSchema], default: [] },
    /** Objects pruned by the retention sweep across all buckets. */
    prunedCount: { type: Number, default: 0 },
    error: { type: String, default: '' },
    by: { type: String, default: '' },
  },
  { timestamps: true },
);

backupRecordSchema.index({ startedAt: -1 });

export const BackupRecord = model('BackupRecord', backupRecordSchema);
