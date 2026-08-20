import { connectDb, disconnectDb } from '../db/connect';
import { getSettings } from '../models/Setting';
import { getAdminProfile } from '../models/AdminProfile';
import { ensureDefaultRoles } from '../models/Role';

// Idempotent bootstrap. Creates ONLY what the system cannot start without:
// the roles, the first admin account, and the settings document.
//
// It deliberately creates NO products, prices, coupons or customers. Inventing
// a catalogue would put prices on the live storefront that nobody chose — the
// real ones get entered in the admin panel, which is the only place they should
// come from. Safe to run against a live database.

async function seed() {
  await connectDb();

  await getSettings(); // ensures the settings doc exists
  await getAdminProfile();
  await ensureDefaultRoles();

  console.log('[seed] done — no catalogue was created.');
  console.log('[seed] the primary admin authenticates through server/.env; team accounts use hashed database credentials.');
  console.log('[seed] next: sign in to the admin panel and add your products,');
  console.log('[seed] packs and prices. The storefront shows nothing until you do.');
  await disconnectDb();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
