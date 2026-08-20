import { Schema, model } from 'mongoose';

// Face lock — the enrolled face for one admin, as 128-number descriptors
// (one per captured pose: front, left, right). No photo is ever stored;
// a descriptor is a mathematical signature the camera image is reduced to
// in the admin's own browser.

const faceLockSchema = new Schema(
  {
    /** 'primary' for the .env owner, otherwise the AdminUser id. */
    adminId: { type: String, required: true, unique: true },
    /** One 128-float descriptor per captured pose. */
    descriptors: { type: [[Number]], required: true },
    lastUsedAt: { type: Date, default: null },
  },
  { versionKey: false, timestamps: true },
);

export const FaceLock = model('FaceLock', faceLockSchema);
