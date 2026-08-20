import { Schema, model } from 'mongoose';

const adminUserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    roleId: { type: String, required: true, ref: 'Role' },
    active: { type: Boolean, default: true },
    avatarUrl: { type: String, default: '' },
    readNotificationIds: { type: [String], default: [] },
    preferences: {
      fontScale: { type: Number, default: 100, min: 90, max: 120 },
      density: { type: String, enum: ['comfortable', 'compact'], default: 'comfortable' },
      sidebarCollapsed: { type: Boolean, default: false },
      reduceMotion: { type: Boolean, default: false },
    },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

export const AdminUser = model('AdminUser', adminUserSchema);
