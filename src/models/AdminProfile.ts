import { Schema, model } from 'mongoose';
const adminProfileSchema = new Schema(
  {
    _id: { type: String, default: 'primary' },
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
    {
      $setOnInsert: { _id: 'primary' },
      // Remove identity values written by older builds. The primary admin's
      // name/email/password are environment configuration, never database data.
      $unset: { name: '', email: '' },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true, strict: false },
  );
}
