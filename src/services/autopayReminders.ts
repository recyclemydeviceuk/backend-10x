import { Subscription } from '../models/Subscription';
import { Customer } from '../models/Customer';
import { getSettings } from '../models/Setting';
import { emails } from './emails';
import { logEvent } from '../models/Event';

// =========================================================
// Auto-pay nudges.
//
// A subscriber who paid their first box by card/UPI has a plan that ships
// pay-on-delivery until they approve a mandate. Every few days (store
// setting) they get one email asking them to set it up, with a clear
// "I'll pay on delivery" opt-out that ends the loop. Capped, so nobody is
// nagged forever.
// =========================================================

type Sub = InstanceType<typeof Subscription>;

/** Plans that still need a mandate and have not said no. */
export function needsAutopayNudge(sub: Sub): boolean {
  return (
    sub.status === 'active' &&
    sub.autopay.status !== 'active' &&
    sub.autopay.status !== 'initialized' &&
    !sub.autopay.declinedAt
  );
}

/**
 * Send one reminder for a plan. `force` is the admin button — it ignores
 * the cadence and the cap (but never the customer's decline).
 */
export async function sendAutopayReminder(
  sub: Sub,
  opts: { force?: boolean } = {},
): Promise<{ sent: boolean; reason?: string }> {
  if (sub.status !== 'active') return { sent: false, reason: 'Plan is not active.' };
  if (sub.autopay.status === 'active') return { sent: false, reason: 'Auto-pay is already on.' };
  if (sub.autopay.declinedAt) return { sent: false, reason: 'The customer chose pay on delivery.' };

  const customer = await Customer.findById(sub.customerId).select('name email');
  if (!customer?.email) return { sent: false, reason: 'Customer has no email.' };

  const next = sub.autopay.reminderCount + 1;
  await emails.autopayReminder({
    email: customer.email,
    name: customer.name,
    reference: sub.reference,
    planName: sub.planName,
    price: sub.price * sub.quantity,
    nextDelivery: sub.nextDelivery ?? null,
    reminderNumber: next,
  });
  sub.autopay.reminderCount = next;
  sub.autopay.lastReminderAt = new Date();
  await sub.save();
  await logEvent(
    'subscription',
    `${sub.reference} auto-pay reminder ${next}${opts.force ? ' (sent by team)' : ''}`,
    customer.name,
    '/subscriptions',
  );
  return { sent: true };
}

/**
 * The scheduled sweep. Called from the syncing worker; returns one line per
 * reminder sent so it shows up in the automation log.
 */
export async function runAutopayReminderSweep(limit = 50): Promise<string[]> {
  const settings = await getSettings();
  const everyDays = settings.store.autopayReminderEveryDays;
  const max = settings.store.autopayReminderMax;
  if (!everyDays || everyDays <= 0 || max <= 0) return [];

  const cutoff = new Date(Date.now() - everyDays * 86400_000);
  const due = await Subscription.find({
    status: 'active',
    'autopay.status': { $nin: ['active', 'initialized'] },
    'autopay.declinedAt': null,
    'autopay.reminderCount': { $lt: max },
    // First nudge `everyDays` after the plan started, then every `everyDays`.
    $or: [
      { 'autopay.lastReminderAt': null, startedAt: { $lte: cutoff } },
      { 'autopay.lastReminderAt': { $ne: null, $lte: cutoff } },
    ],
  }).limit(limit);

  const actions: string[] = [];
  for (const sub of due) {
    try {
      const result = await sendAutopayReminder(sub);
      if (result.sent) actions.push(`${sub.reference}: auto-pay reminder ${sub.autopay.reminderCount}/${max} sent`);
    } catch (err) {
      actions.push(`${sub.reference}: auto-pay reminder failed — ${err instanceof Error ? err.message : 'error'}`);
    }
  }
  return actions;
}
