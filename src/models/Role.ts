import { Schema, model } from 'mongoose';

const roleSchema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true, unique: true },
    description: { type: String, default: '', trim: true },
    permissions: { type: [String], default: [] },
    system: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
);

export const Role = model('Role', roleSchema);

export async function ensureDefaultRoles() {
  await Promise.all([
    Role.findOneAndUpdate(
      { _id: 'super-admin' },
      { $setOnInsert: { _id: 'super-admin', name: 'Super Admin', description: 'Full access to every admin function.', permissions: ['*'], system: true } },
      { upsert: true, new: true },
    ),
    Role.findOneAndUpdate(
      { _id: 'store-manager' },
      {
        $setOnInsert: {
          _id: 'store-manager',
          name: 'Store Manager',
          description: 'Daily store operations without team, role, or backup administration.',
          permissions: [
            'dashboard.view', 'analytics.view', 'orders.*', 'fulfilment.*', 'transactions.*',
            'returns.*', 'queries.*', 'customers.*', 'subscriptions.*', 'products.*', 'inventory.*', 'coupons.*',
          ],
          system: true,
        },
      },
      { upsert: true, new: true },
    ),
  ]);
}
