import { Schema, model } from 'mongoose';

// Early-access signups from the coming-soon page. One row per email — the
// form can be submitted twice without creating duplicates.

const signupSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    source: { type: String, default: 'coming-soon' },
  },
  { versionKey: false, timestamps: true },
);

export const Signup = model('Signup', signupSchema);
