import { Schema, model } from 'mongoose';
import { env } from '../config/env';

const adminProfileSchema = new Schema(
  {
    _id: { type: String, default: 'primary' },
    name: { type: String, required: true, trim: true, default: () => env.adminName },
    /** Contact/display email. The sign-in identifier remains ADMIN_EMAIL. */
    email: { type: String, required: true, lowercase: true, trim: true, default: () => env.adminEmail },
    avatarUrl: { type: String, default: '' },
    readNotificationIds: { type: [String], default: [] },
    preferences: {
      fontScale: { type: Number, default: 100, min: 90, max: 120 },
      density: { type: String, enum: ['comfortable', 'compact'], default: 'comfortable' },
      sidebarCollapsed: { type: Boolean, default: false },
      reduceMotion: { type: Boolean, default: false },
    },
  },
  { timestamps: true, versionKey: false },
);

export const AdminProfile = model('AdminProfile', adminProfileSchema);

export async function getAdminProfile() {
  return AdminProfile.findOneAndUpdate(
    { _id: 'primary' },
    { $setOnInsert: { _id: 'primary', name: env.adminName, email: env.adminEmail } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}
