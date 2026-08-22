import { sendEmail } from './ses';
import type { OrderDoc } from '../models/Order';
import { env } from '../config/env';
import { getSettings } from '../models/Setting';

// 10X transactional email.
//
// One quiet layout for every message: white paper, black type, a single
// green rule and a green button. The logo is the storefront's black mark on
// white — never a dark band. Copy is short and plain: what happened, what
// (if anything) to do next.

const BRAND = {
  ink: '#000204',
  green: '#6DE325',
  greenDark: '#4EA310',
  paper: '#FFFFFF',
  line: '#E6E8E4',
  muted: '#5F665F',
  soft: '#F6F8F4',
} as const;

const FONT = `'Helvetica Neue',Helvetica,Arial,sans-serif`;

const inr = (amount: number) => `₹${Math.round(amount).toLocaleString('en-IN')}`;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const lineBreaks = (value: unknown) => escapeHtml(value).replace(/\r?\n/g, '<br />');

function date(value: Date | null): string {
  return value
    ? value.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'To be confirmed';
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || 'there';
}

type Detail = { label: string; value: string };
type Action = { label: string; href: string };

/** Body copy. Already-escaped HTML may be passed (callers escape user data). */
function paragraph(copy: string): string {
  return `<p style="margin:0 0 18px;color:${BRAND.ink};font-family:${FONT};font-size:15px;line-height:1.7;">${copy}</p>`;
}

/** Secondary note — smaller, grey. */
function note(copy: string): string {
  return `<p style="margin:0 0 18px;color:${BRAND.muted};font-family:${FONT};font-size:13px;line-height:1.7;">${copy}</p>`;
}

/** Label / value rows, hairline-separated. */
function details(rows: Detail[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;border-collapse:collapse;">
    ${rows
      .map(
        (row) => `<tr>
          <td style="padding:12px 0;border-top:1px solid ${BRAND.line};color:${BRAND.muted};font-family:${FONT};font-size:13px;line-height:1.4;">${escapeHtml(row.label)}</td>
          <td align="right" style="padding:12px 0;border-top:1px solid ${BRAND.line};color:${BRAND.ink};font-family:${FONT};font-size:14px;font-weight:700;line-height:1.4;">${escapeHtml(row.value)}</td>
        </tr>`,
      )
      .join('')}
    <tr><td colspan="2" style="border-top:1px solid ${BRAND.line};font-size:0;line-height:0;">&nbsp;</td></tr>
  </table>`;
}

/** One value that matters — a code, a temporary password. Large, on a light green field. */
function focusValue(label: string, value: string, hint = ''): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;border-collapse:collapse;">
    <tr><td align="center" style="padding:26px 20px;background:${BRAND.soft};border-left:4px solid ${BRAND.green};">
      <div style="color:${BRAND.muted};font-family:${FONT};font-size:12px;line-height:1.4;">${escapeHtml(label)}</div>
      <div style="margin-top:8px;color:${BRAND.ink};font-family:${FONT};font-size:30px;font-weight:700;letter-spacing:.12em;line-height:1.2;">${escapeHtml(value)}</div>
      ${hint ? `<div style="margin-top:8px;color:${BRAND.muted};font-family:${FONT};font-size:12px;line-height:1.5;">${escapeHtml(hint)}</div>` : ''}
    </td></tr>
  </table>`;
}

/** Quoted message — theirs or ours. */
function quote(copy: string): string {
  return `<div style="margin:8px 0 24px;padding:16px 20px;border-left:4px solid ${BRAND.green};background:${BRAND.soft};color:${BRAND.ink};font-family:${FONT};font-size:14px;line-height:1.7;">${lineBreaks(copy)}</div>`;
}

function orderSummary(order: Pick<OrderDoc, 'items' | 'discount' | 'shippingFee' | 'total'>): string {
  const cell = `padding:12px 0;border-top:1px solid ${BRAND.line};font-family:${FONT};font-size:14px;line-height:1.5;`;
  const itemRows = order.items
    .map(
      (item) => `<tr>
        <td style="${cell}color:${BRAND.ink};">
          ${escapeHtml(item.name)}${item.tierName ? `<span style="color:${BRAND.muted};"> · ${escapeHtml(item.tierName)}</span>` : ''}<span style="color:${BRAND.muted};"> × ${item.quantity}</span>
        </td>
        <td align="right" style="${cell}color:${BRAND.ink};font-weight:700;">${inr(item.unitPrice * item.quantity)}</td>
      </tr>`,
    )
    .join('');
  const small = `padding:8px 0;font-family:${FONT};font-size:13px;line-height:1.5;`;

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;border-collapse:collapse;">
    ${itemRows}
    ${order.discount > 0 ? `<tr><td style="${small}padding-top:14px;border-top:1px solid ${BRAND.line};color:${BRAND.muted};">Discount</td><td align="right" style="${small}padding-top:14px;border-top:1px solid ${BRAND.line};color:${BRAND.greenDark};font-weight:700;">−${inr(order.discount)}</td></tr>` : ''}
    <tr><td style="${small}${order.discount > 0 ? '' : `padding-top:14px;border-top:1px solid ${BRAND.line};`}color:${BRAND.muted};">Delivery</td><td align="right" style="${small}${order.discount > 0 ? '' : `padding-top:14px;border-top:1px solid ${BRAND.line};`}color:${BRAND.ink};">${order.shippingFee > 0 ? inr(order.shippingFee) : 'Free'}</td></tr>
    <tr><td style="padding:14px 0 0;border-top:1px solid ${BRAND.line};color:${BRAND.ink};font-family:${FONT};font-size:15px;font-weight:700;">Total</td><td align="right" style="padding:14px 0 0;border-top:1px solid ${BRAND.line};color:${BRAND.ink};font-family:${FONT};font-size:20px;font-weight:700;">${inr(order.total)}</td></tr>
  </table>`;
}

function template(input: {
  preheader: string;
  label: string;
  title: string;
  body: string;
  action?: Action;
  footer?: string;
}): string {
  const storeUrl = escapeHtml(env.storefrontUrl);
  const storeHost = escapeHtml(env.storefrontUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''));
  // The storefront's own black logo, on white — one mark everywhere.
  const logoUrl = escapeHtml(`${env.storefrontUrl.replace(/\/$/, '')}/logo.png`);
  const action = input.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 8px;"><tr><td bgcolor="${BRAND.green}" style="background:${BRAND.green};border-radius:2px;">
        <a href="${escapeHtml(input.action.href)}" style="display:inline-block;padding:14px 24px;color:${BRAND.ink};font-family:${FONT};font-size:14px;font-weight:700;text-decoration:none;">${escapeHtml(input.action.label)}</a>
      </td></tr></table>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>${escapeHtml(input.title)}</title>
  <style>@media only screen and (max-width:620px){.email-shell{width:100%!important}.email-pad{padding:28px 22px!important}.email-head{padding:26px 22px 0!important}}</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.paper};color:${BRAND.ink};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${BRAND.paper};">
    <tr><td align="center" style="padding:28px 16px;">
      <table class="email-shell" role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:560px;border-collapse:collapse;background:${BRAND.paper};">
        <tr><td class="email-head" style="padding:18px 36px 0;">
          <a href="${storeUrl}" style="display:inline-block;text-decoration:none;">
            <img src="${logoUrl}" width="72" height="35" alt="10X" style="display:block;width:72px;height:auto;border:0;outline:none;" />
          </a>
        </td></tr>
        <tr><td style="padding:22px 36px 0;"><div style="height:3px;width:44px;background:${BRAND.green};font-size:0;line-height:0;">&nbsp;</div></td></tr>
        <tr><td class="email-pad" style="padding:28px 36px 36px;">
          <div style="margin:0 0 10px;color:${BRAND.greenDark};font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;">${escapeHtml(input.label)}</div>
          <h1 style="margin:0 0 20px;color:${BRAND.ink};font-family:${FONT};font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.2;">${escapeHtml(input.title)}</h1>
          ${input.body}
          ${action}
        </td></tr>
        <tr><td style="padding:20px 36px 8px;border-top:1px solid ${BRAND.line};">
          <p style="margin:0;color:${BRAND.muted};font-family:${FONT};font-size:12px;line-height:1.7;">
            ${escapeHtml(input.footer ?? 'You’re receiving this because of activity on your 10X account.')}
          </p>
          <p style="margin:10px 0 0;color:${BRAND.muted};font-family:${FONT};font-size:12px;line-height:1.7;">
            <a href="${storeUrl}" style="color:${BRAND.ink};font-weight:700;text-decoration:none;">${storeHost}</a>
            &nbsp;·&nbsp; 10X — Fuel better thinking.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function plain(title: string, blocks: Array<string | null | undefined>, action?: Action): string {
  return [
    '10X',
    '',
    title,
    '',
    ...blocks.filter(Boolean),
    ...(action ? ['', `${action.label}: ${action.href}`] : []),
    '',
    '—',
    env.storefrontUrl.replace(/^https?:\/\//, ''),
    'Fuel better thinking.',
  ].join('\n');
}

function compactMessage(message: string, limit = 420): string {
  const clean = message.trim();
  return clean.length > limit ? `${clean.slice(0, limit).trimEnd()}…` : clean;
}

type OrderLike = OrderDoc & { reference: string };

export const emails = {
  async orderConfirmed(order: OrderLike) {
    const cod = order.paymentMethod === 'cod';
    const action = { label: 'View order', href: `${env.storefrontUrl}/account/orders` };
    const title = 'Thanks — your order is in.';
    return sendEmail({
      to: [{ email: order.customerEmail, name: order.customerName }],
      subject: `${order.reference} confirmed · 10X`,
      html: template({
        preheader: `Your 10X order ${order.reference} is confirmed.`,
        label: 'Order confirmed',
        title,
        body:
          paragraph(`Hi ${escapeHtml(firstName(order.customerName))}, we’ve got it. We’ll email you again the moment it ships.`) +
          orderSummary(order) +
          details([
            { label: 'Order', value: order.reference },
            { label: 'Payment', value: cod ? `${inr(order.total)}, cash on delivery` : 'Paid' },
          ]),
        action,
      }),
      text: plain(title, [
        `Hi ${firstName(order.customerName)}, we’ve got it. We’ll email you again the moment it ships.`,
        `Order: ${order.reference}`,
        `Total: ${inr(order.total)}`,
        `Payment: ${cod ? 'Cash on delivery' : 'Paid online'}`,
      ], action),
    });
  },

  async orderShipped(order: OrderLike) {
    const courier = order.shipment?.courier || order.courier || 'Courier partner';
    const tracking = order.shipment?.awb || order.trackingNumber || 'Updating shortly';
    const action = { label: 'Track order', href: `${env.storefrontUrl}/account/orders` };
    const title = 'It’s on the way.';
    return sendEmail({
      to: [{ email: order.customerEmail, name: order.customerName }],
      subject: `${order.reference} has shipped · 10X`,
      html: template({
        preheader: `Order ${order.reference} has shipped with ${courier}.`,
        label: 'Order shipped',
        title,
        body: paragraph('Your box has left our warehouse. Tracking can take a few hours to show the first scan.') + details([
          { label: 'Order', value: order.reference },
          { label: 'Courier', value: courier },
          { label: 'Tracking', value: tracking },
        ]),
        action,
      }),
      text: plain(title, [`Order: ${order.reference}`, `Courier: ${courier}`, `Tracking: ${tracking}`], action),
    });
  },

  async orderDelivered(order: OrderLike) {
    const action = { label: 'View order', href: `${env.storefrontUrl}/account/orders` };
    const title = 'Delivered. Enjoy.';
    return sendEmail({
      to: [{ email: order.customerEmail, name: order.customerName }],
      subject: `${order.reference} delivered · 10X`,
      html: template({
        preheader: `Order ${order.reference} has been delivered.`,
        label: 'Order delivered',
        title,
        body: paragraph(`Order ${escapeHtml(order.reference)} has reached you.`) + note('Not right? You can start a return from your account within 7 days of delivery.'),
        action,
      }),
      text: plain(title, [`Order ${order.reference} has arrived.`, 'Returns can be requested from your account within 7 days.'], action),
    });
  },

  async orderCancelled(order: OrderLike) {
    const paid = order.paymentMethod === 'online' && ['paid', 'refunded'].includes(order.paymentStatus);
    const action = { label: 'View orders', href: `${env.storefrontUrl}/account/orders` };
    const title = 'This order is cancelled.';
    return sendEmail({
      to: [{ email: order.customerEmail, name: order.customerName }],
      subject: `${order.reference} cancelled · 10X`,
      html: template({
        preheader: `Order ${order.reference} has been cancelled.`,
        label: 'Order cancelled',
        title,
        body: details([
          { label: 'Order', value: order.reference },
          { label: 'Total', value: inr(order.total) },
        ]) + paragraph(paid ? 'Your payment is being refunded to the card or account you paid with. We’ll email you when it’s sent.' : 'Nothing has been charged.'),
        action,
      }),
      text: plain(title, [
        `Order: ${order.reference}`,
        `Total: ${inr(order.total)}`,
        paid ? 'Your payment is being refunded — we’ll email you when it’s sent.' : 'Nothing has been charged.',
      ], action),
    });
  },

  async orderRefunded(order: OrderLike) {
    const online = order.paymentMethod === 'online';
    const action = { label: 'View order', href: `${env.storefrontUrl}/account/orders` };
    const title = 'Your refund is on its way.';
    const timing = online ? 'It goes back to the card or account you paid with. Banks usually take 5–7 working days to show it.' : 'We’ll be in touch to arrange the payout.';
    return sendEmail({
      to: [{ email: order.customerEmail, name: order.customerName }],
      subject: `Refund issued for ${order.reference} · 10X`,
      html: template({
        preheader: `${inr(order.total)} has been refunded for ${order.reference}.`,
        label: 'Refund issued',
        title,
        body: details([
          { label: 'Order', value: order.reference },
          { label: 'Amount', value: inr(order.total) },
          { label: 'Sent to', value: online ? 'The way you paid' : 'Bank transfer' },
        ]) + paragraph(timing),
        action,
      }),
      text: plain(title, [`Order: ${order.reference}`, `Amount: ${inr(order.total)}`, timing], action),
    });
  },

  async returnUpdate(args: {
    email: string;
    name: string;
    reference: string;
    orderReference: string;
    status: 'requested' | 'approved' | 'received' | 'refunded' | 'rejected';
    amount: number;
    rejectReason?: string;
  }) {
    const copy = {
      requested: {
        label: 'Return received',
        title: 'We’ve got your return request.',
        note: 'We’ll look at it within 1–2 working days and email you either way.',
      },
      approved: {
        label: 'Return approved',
        title: 'Your return is approved.',
        note: 'A courier will come to collect it. Keep the product and its box ready.',
      },
      received: {
        label: 'Return received',
        title: 'Your return has arrived.',
        note: 'We’re sending your refund now.',
      },
      refunded: {
        label: 'Return refunded',
        title: 'Your refund is on its way.',
        note: 'Banks usually take 5–7 working days to show it.',
      },
      rejected: {
        label: 'Return update',
        title: 'We couldn’t approve this return.',
        note: args.rejectReason ? `Reason: ${args.rejectReason}` : 'Reply to this email if you’d like us to take another look.',
      },
    }[args.status];
    const action = { label: 'View return', href: `${env.storefrontUrl}/account` };
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: `${args.reference} · ${copy.label} · 10X`,
      html: template({
        preheader: `${copy.title} Return ${args.reference}.`,
        label: copy.label,
        title: copy.title,
        body: details([
          { label: 'Return', value: args.reference },
          { label: 'Order', value: args.orderReference },
          { label: 'Amount', value: inr(args.amount) },
        ]) + paragraph(escapeHtml(copy.note)),
        action,
      }),
      text: plain(copy.title, [`Return: ${args.reference}`, `Order: ${args.orderReference}`, `Amount: ${inr(args.amount)}`, copy.note], action),
    });
  },

  /**
   * Sent the moment a plan is created. The primary button is auto-pay set-up
   * (the first, strongest nudge — the card is still out); the reminder loop
   * takes over from there if they don't.
   */
  async subscriptionStarted(args: {
    email: string;
    name: string;
    reference?: string;
    planName: string;
    price: number;
    nextDelivery: Date | null;
  }) {
    const base = `${env.storefrontUrl}/account/subscriptions`;
    const action = args.reference
      ? { label: 'Set up auto-pay', href: `${base}?autopay-setup=${encodeURIComponent(args.reference)}` }
      : { label: 'Manage subscription', href: base };
    const title = 'Your subscription is set.';
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: `Subscription active · 10X`,
      html: template({
        preheader: `${args.planName} is now active.`,
        label: 'Subscription active',
        title,
        body:
          details([
            { label: 'Plan', value: args.planName },
            { label: 'Per cycle', value: inr(args.price) },
            { label: 'Next delivery', value: date(args.nextDelivery) },
          ]) +
          paragraph('Right now, each box is paid for on delivery. Set up auto-pay once and every box after this is paid automatically.') +
          note('Pause or cancel any time from your account.'),
        action,
      }),
      text: plain(
        title,
        [
          `Plan: ${args.planName}`,
          `Per cycle: ${inr(args.price)}`,
          `Next delivery: ${date(args.nextDelivery)}`,
          'Right now, each box is paid for on delivery. Set up auto-pay once and every box after this is paid automatically.',
        ],
        action,
      ),
    });
  },

  /**
   * The auto-pay nudge. Two buttons: set it up, or say "pay on delivery" —
   * both land on the account page, which handles sign-in and the action.
   */
  async autopayReminder(args: {
    email: string;
    name: string;
    reference: string;
    planName: string;
    price: number;
    nextDelivery: Date | null;
    reminderNumber: number;
  }) {
    const base = `${env.storefrontUrl}/account/subscriptions`;
    const action = { label: 'Set up auto-pay', href: `${base}?autopay-setup=${encodeURIComponent(args.reference)}` };
    const declineHref = `${base}?autopay-decline=${encodeURIComponent(args.reference)}`;
    const title = 'Skip paying at the door.';
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: `Set up auto-pay for ${args.planName} · 10X`,
      html: template({
        preheader: 'Set up auto-pay once and every box is paid automatically.',
        label: 'Auto-pay',
        title,
        body:
          paragraph(
            `Right now you pay for each ${escapeHtml(args.planName)} box when it arrives. Set up auto-pay once — with UPI, a card or your bank — and every box after that is paid for you. Nothing to do at the door.`,
          ) +
          details([
            { label: 'Plan', value: args.planName },
            { label: 'Per cycle', value: inr(args.price) },
            { label: 'Next delivery', value: date(args.nextDelivery) },
          ]) +
          note(
            `Happy paying on delivery? <a href="${declineHref}" style="color:${BRAND.greenDark};font-weight:bold;">Tell us here</a> and we’ll stop these reminders. You can turn auto-pay on any time from your account.`,
          ),
        action,
      }),
      text: plain(
        title,
        [
          `Plan: ${args.planName}`,
          `Per cycle: ${inr(args.price)}`,
          `Next delivery: ${date(args.nextDelivery)}`,
          `Prefer pay on delivery? ${declineHref}`,
        ],
        action,
      ),
    });
  },

  async subscriptionUpdated(args: {
    email: string;
    name: string;
    reference: string;
    planName: string;
    status: 'active' | 'paused' | 'cancelled';
    nextDelivery: Date | null;
  }) {
    const copy = {
      active: {
        label: 'Subscription active',
        title: 'Your subscription is active.',
        note: `Next delivery: ${date(args.nextDelivery)}.`,
      },
      paused: {
        label: 'Subscription paused',
        title: 'Your subscription is paused.',
        note: 'Nothing ships and nothing is charged until you resume it.',
      },
      cancelled: {
        label: 'Subscription cancelled',
        title: 'Your subscription is cancelled.',
        note: 'No more deliveries, no more charges. You can start again any time.',
      },
    }[args.status];
    const action = { label: 'Manage subscriptions', href: `${env.storefrontUrl}/account/subscriptions` };
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: `${args.reference} ${args.status} · 10X`,
      html: template({
        preheader: copy.title,
        label: copy.label,
        title: copy.title,
        body: details([
          { label: 'Subscription', value: args.reference },
          { label: 'Plan', value: args.planName },
        ]) + paragraph(copy.note),
        action,
      }),
      text: plain(copy.title, [`Subscription: ${args.reference}`, `Plan: ${args.planName}`, copy.note], action),
    });
  },

  async queryReceived(args: { email: string; name: string; reference: string; message: string }) {
    const action = { label: 'Visit 10X', href: env.storefrontUrl };
    const title = 'We’ve got your message.';
    const message = compactMessage(args.message);
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: `${args.reference} received · 10X`,
      html: template({
        preheader: `We’ll reply within a working day. Reference ${args.reference}.`,
        label: 'Message received',
        title,
        body: paragraph('Thanks for writing. We usually reply within one working day.') + quote(message) + note(`Your reference is ${escapeHtml(args.reference)}.`),
        action,
        footer: 'Reply to this email and it reaches the same person.',
      }),
      text: plain(title, ['Thanks for writing. We usually reply within one working day.', `Your message: ${message}`, `Reference: ${args.reference}`], action),
      replyTo: (await getSettings()).store.supportEmail,
    });
  },

  async queryAnswered(args: { email: string; name: string; reference: string; reply: string }) {
    const action = { label: 'Visit 10X', href: env.storefrontUrl };
    const title = 'Here’s our reply.';
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: `Re: ${args.reference} · 10X`,
      html: template({
        preheader: `We replied to your message ${args.reference}.`,
        label: 'Support reply',
        title,
        body: quote(args.reply) + note(`Reference ${escapeHtml(args.reference)}. Reply to this email if there’s anything else.`),
        action,
        footer: 'Reply to this email to continue the conversation.',
      }),
      text: plain(title, [args.reply, `Reference: ${args.reference}`], action),
      replyTo: (await getSettings()).store.supportEmail,
    });
  },

  async emailChangeCode(args: { email: string; name: string; code: string }) {
    const title = 'Your confirmation code.';
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: `${args.code} is your 10X code`,
      html: template({
        preheader: `Your 10X confirmation code is ${args.code}.`,
        label: 'Email change',
        title,
        body: focusValue('Enter this code to confirm your new email', args.code, 'It works for 15 minutes') + note('Didn’t ask to change your email? Ignore this and nothing will change.'),
        footer: 'We will never ask you for this code. Don’t share it with anyone.',
      }),
      text: plain(title, [`Code: ${args.code}`, 'Expires in 15 minutes.', 'If you did not request this change, ignore this email.']),
    });
  },

  async passwordReset(args: { email: string; name: string; token: string }) {
    const action = { label: 'Choose new password', href: `${env.storefrontUrl}/reset-password?token=${encodeURIComponent(args.token)}` };
    const title = 'Choose a new password.';
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: 'Reset your 10X password',
      html: template({
        preheader: 'Here’s your link to set a new 10X password.',
        label: 'Password reset',
        title,
        body: paragraph('Use the button below to set a new password. The link works for 60 minutes.') + note('Didn’t ask for this? Ignore it — your password stays as it is.'),
        action,
        footer: 'This link only lets you set a new password — nothing else.',
      }),
      text: plain(title, ['Use the link below to set a new password. It works for 60 minutes.', 'Didn’t ask for this? Ignore it — your password stays as it is.'], action),
    });
  },

  async teamInvite(args: { email: string; name: string; tempPassword: string; roleName: string }) {
    const action = { label: 'Open admin panel', href: env.adminUrl };
    const title = 'You’re on the 10X team.';
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: 'Your 10X admin account',
      html: template({
        preheader: `Your ${args.roleName} login for the 10X admin panel.`,
        label: 'Admin panel',
        title,
        body: details([
          { label: 'Email', value: args.email },
          { label: 'Role', value: args.roleName },
        ]) + focusValue('Temporary password', args.tempPassword, 'Change it the first time you sign in'),
        action,
        footer: 'If you weren’t expecting this, reply and let us know.'
      }),
      text: plain(title, [`Email: ${args.email}`, `Role: ${args.roleName}`, `Temporary password: ${args.tempPassword}`, 'Change it after your first sign-in.'], action),
    });
  },
};
