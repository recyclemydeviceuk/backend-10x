import { sendEmail } from './ses';
import type { OrderDoc } from '../models/Order';
import { env } from '../config/env';
import { getSettings } from '../models/Setting';

// 10X transactional email system.
// One restrained visual language across every message: true ink, white and
// the brand lawn green. Every template uses the canonical storefront logo.

const BRAND = {
  ink: '#000204',
  green: '#6DE325',
  greenDark: '#4EA310',
  paper: '#FFFFFF',
  canvas: '#F4F5F2',
  line: '#E5E7E2',
  muted: '#69706A',
  soft: '#F7F8F5',
} as const;

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

function paragraph(copy: string): string {
  return `<p style="margin:0 0 22px;color:${BRAND.muted};font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;">${copy}</p>`;
}

function details(rows: Detail[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0;border-collapse:collapse;border-top:1px solid ${BRAND.line};">
    ${rows
      .map(
        (row) => `<tr>
          <td style="padding:13px 0;border-bottom:1px solid ${BRAND.line};color:${BRAND.muted};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.4;text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(row.label)}</td>
          <td align="right" style="padding:13px 0;border-bottom:1px solid ${BRAND.line};color:${BRAND.ink};font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;line-height:1.4;">${escapeHtml(row.value)}</td>
        </tr>`,
      )
      .join('')}
  </table>`;
}

function focusValue(label: string, value: string, note = ''): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0;border-collapse:collapse;background:${BRAND.ink};">
    <tr><td align="center" style="padding:24px;">
      <div style="color:#AEB4AE;font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;">${escapeHtml(label)}</div>
      <div style="margin-top:8px;color:${BRAND.green};font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:800;letter-spacing:.08em;line-height:1.2;">${escapeHtml(value)}</div>
      ${note ? `<div style="margin-top:8px;color:#D8DCD7;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;">${escapeHtml(note)}</div>` : ''}
    </td></tr>
  </table>`;
}

function quote(copy: string): string {
  return `<div style="margin:26px 0;padding:18px 20px;border-left:4px solid ${BRAND.green};background:${BRAND.soft};color:${BRAND.ink};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;">${lineBreaks(copy)}</div>`;
}

function orderSummary(order: Pick<OrderDoc, 'items' | 'discount' | 'shippingFee' | 'total'>): string {
  const itemRows = order.items
    .map(
      (item) => `<tr>
        <td style="padding:11px 0;border-bottom:1px solid ${BRAND.line};color:${BRAND.ink};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;">
          ${escapeHtml(item.name)}${item.tierName ? ` <span style="color:${BRAND.muted};">· ${escapeHtml(item.tierName)}</span>` : ''}
          <span style="color:${BRAND.muted};"> × ${item.quantity}</span>
        </td>
        <td align="right" style="padding:11px 0;border-bottom:1px solid ${BRAND.line};color:${BRAND.ink};font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;">${inr(item.unitPrice * item.quantity)}</td>
      </tr>`,
    )
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0;border-collapse:collapse;">
    ${itemRows}
    ${order.discount > 0 ? `<tr><td style="padding-top:12px;color:${BRAND.muted};font-family:Arial,Helvetica,sans-serif;font-size:13px;">Discount</td><td align="right" style="padding-top:12px;color:${BRAND.greenDark};font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;">−${inr(order.discount)}</td></tr>` : ''}
    <tr><td style="padding-top:8px;color:${BRAND.muted};font-family:Arial,Helvetica,sans-serif;font-size:13px;">Delivery</td><td align="right" style="padding-top:8px;color:${BRAND.ink};font-family:Arial,Helvetica,sans-serif;font-size:13px;">${order.shippingFee > 0 ? inr(order.shippingFee) : 'Free'}</td></tr>
    <tr><td style="padding-top:15px;color:${BRAND.ink};font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:800;">Total</td><td align="right" style="padding-top:15px;color:${BRAND.ink};font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:800;">${inr(order.total)}</td></tr>
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
  const logoUrl = escapeHtml(`${env.storefrontUrl.replace(/\/$/, '')}/logo-white.png`);
  const action = input.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:30px 0 4px;"><tr><td bgcolor="${BRAND.green}" style="background:${BRAND.green};">
        <a href="${escapeHtml(input.action.href)}" style="display:inline-block;padding:14px 22px;color:${BRAND.ink};font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:800;letter-spacing:.08em;text-decoration:none;text-transform:uppercase;">${escapeHtml(input.action.label)}</a>
      </td></tr></table>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <title>${escapeHtml(input.title)}</title>
  <style>@media only screen and (max-width:620px){.email-shell{width:100%!important}.email-pad{padding:30px 24px!important}.email-frame{padding:0!important}}</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.canvas};color:${BRAND.ink};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${BRAND.canvas};">
    <tr><td class="email-frame" align="center" style="padding:34px 16px;">
      <table class="email-shell" role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;border-collapse:collapse;background:${BRAND.paper};">
        <tr><td style="padding:20px 34px;background:${BRAND.ink};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td>
              <img src="${logoUrl}" width="62" height="30" alt="10X" style="display:block;width:62px;height:auto;border:0;outline:none;text-decoration:none;" />
            </td>
            <td align="right" style="color:#AEB4AE;font-family:Arial,Helvetica,sans-serif;font-size:9px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;">The Brain Battery</td>
          </tr></table>
        </td></tr>
        <tr><td style="height:4px;background:${BRAND.green};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td class="email-pad" style="padding:42px 42px 38px;">
          <div style="margin:0 0 12px;color:${BRAND.greenDark};font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;">${escapeHtml(input.label)}</div>
          <h1 style="margin:0 0 18px;color:${BRAND.ink};font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:800;letter-spacing:-.035em;line-height:1.15;">${escapeHtml(input.title)}</h1>
          ${input.body}
          ${action}
        </td></tr>
        <tr><td style="padding:22px 34px;border-top:1px solid ${BRAND.line};background:${BRAND.paper};">
          <p style="margin:0;color:${BRAND.muted};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">
            ${escapeHtml(input.footer ?? 'This is a transactional message from 10X.')}
            &nbsp;·&nbsp; <a href="${storeUrl}" style="color:${BRAND.ink};font-weight:700;text-decoration:none;">10xdrink.com</a>
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
    '10X — THE BRAIN BATTERY',
    '',
    title,
    '',
    ...blocks.filter(Boolean),
    ...(action ? ['', `${action.label}: ${action.href}`] : []),
    '',
    '10xdrink.com',
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
    const title = `Order ${order.reference} is confirmed.`;
    return sendEmail({
      to: [{ email: order.customerEmail, name: order.customerName }],
      subject: `${order.reference} confirmed · 10X`,
      html: template({
        preheader: `Your 10X order ${order.reference} is confirmed.`,
        label: 'Order confirmed',
        title,
        body:
          paragraph(`Hi ${escapeHtml(firstName(order.customerName))}, we have your order and will let you know when it ships.`) +
          orderSummary(order) +
          details([
            { label: 'Order', value: order.reference },
            { label: 'Payment', value: cod ? `${inr(order.total)} on delivery` : 'Paid online' },
          ]),
        action,
      }),
      text: plain(title, [
        `Hi ${firstName(order.customerName)}, we have your order and will let you know when it ships.`,
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
    const title = 'Your order is on the way.';
    return sendEmail({
      to: [{ email: order.customerEmail, name: order.customerName }],
      subject: `${order.reference} has shipped · 10X`,
      html: template({
        preheader: `Order ${order.reference} has shipped with ${courier}.`,
        label: 'Order shipped',
        title,
        body: paragraph('Your parcel has left us. Tracking may take a few hours to update.') + details([
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
    const title = 'Delivered.';
    return sendEmail({
      to: [{ email: order.customerEmail, name: order.customerName }],
      subject: `${order.reference} delivered · 10X`,
      html: template({
        preheader: `Order ${order.reference} has been delivered.`,
        label: 'Order delivered',
        title,
        body: paragraph(`Order ${escapeHtml(order.reference)} has arrived. If anything is not right, you can request a return from your account within 7 days.`),
        action,
      }),
      text: plain(title, [`Order ${order.reference} has arrived.`, 'Returns can be requested from your account within 7 days.'], action),
    });
  },

  async orderCancelled(order: OrderLike) {
    const paid = order.paymentMethod === 'online' && ['paid', 'refunded'].includes(order.paymentStatus);
    const action = { label: 'View orders', href: `${env.storefrontUrl}/account/orders` };
    const title = 'Your order is cancelled.';
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
        ]) + paragraph(paid ? 'If payment was collected, the refund is handled separately and we will confirm it by email.' : 'No payment is due for this order.'),
        action,
      }),
      text: plain(title, [
        `Order: ${order.reference}`,
        `Total: ${inr(order.total)}`,
        paid ? 'Any collected payment is handled through the refund process.' : 'No payment is due.',
      ], action),
    });
  },

  async orderRefunded(order: OrderLike) {
    const online = order.paymentMethod === 'online';
    const action = { label: 'View order', href: `${env.storefrontUrl}/account/orders` };
    const title = 'Your refund has been issued.';
    const timing = online ? 'Your bank may take 5–7 working days to show it.' : 'Our team will contact you about the payout.';
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
          { label: 'Method', value: online ? 'Original payment method' : 'Manual payout' },
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
        title: 'We have your return request.',
        note: 'Our team will review it within 1–2 working days.',
      },
      approved: {
        label: 'Return approved',
        title: 'Your pickup is approved.',
        note: 'Keep the product and packaging ready for the courier.',
      },
      received: {
        label: 'Return received',
        title: 'Your parcel is back with us.',
        note: 'We are now processing the refund.',
      },
      refunded: {
        label: 'Return refunded',
        title: 'Your refund has been issued.',
        note: 'Your bank may take 5–7 working days to show it.',
      },
      rejected: {
        label: 'Return update',
        title: 'We could not approve this return.',
        note: args.rejectReason ? `Reason: ${args.rejectReason}` : 'Reply to this email if you need us to review it again.',
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

  async subscriptionStarted(args: { email: string; name: string; planName: string; price: number; nextDelivery: Date | null }) {
    const action = { label: 'Manage subscription', href: `${env.storefrontUrl}/account/subscriptions` };
    const title = 'Your subscription is active.';
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: `Subscription active · 10X`,
      html: template({
        preheader: `${args.planName} is now active.`,
        label: 'Subscription active',
        title,
        body: details([
          { label: 'Plan', value: args.planName },
          { label: 'Per cycle', value: inr(args.price) },
          { label: 'Next delivery', value: date(args.nextDelivery) },
        ]) + paragraph('Pause or cancel any time from your account.'),
        action,
      }),
      text: plain(title, [`Plan: ${args.planName}`, `Per cycle: ${inr(args.price)}`, `Next delivery: ${date(args.nextDelivery)}`], action),
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
        note: 'No deliveries or charges while it is paused.',
      },
      cancelled: {
        label: 'Subscription cancelled',
        title: 'Your subscription is cancelled.',
        note: 'There will be no further deliveries or charges.',
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
    const title = 'We have your message.';
    const message = compactMessage(args.message);
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: `${args.reference} received · 10X`,
      html: template({
        preheader: `Your message is logged as ${args.reference}.`,
        label: 'Message received',
        title,
        body: paragraph(`Reference <strong style="color:${BRAND.ink};">${escapeHtml(args.reference)}</strong>. We usually reply within one working day.`) + quote(message),
        action,
        footer: 'Reply to this email to continue the same conversation.',
      }),
      text: plain(title, [`Reference: ${args.reference}`, 'We usually reply within one working day.', `Your message: ${message}`], action),
      replyTo: (await getSettings()).store.supportEmail,
    });
  },

  async queryAnswered(args: { email: string; name: string; reference: string; reply: string }) {
    const action = { label: 'Visit 10X', href: env.storefrontUrl };
    const title = 'A reply from 10X.';
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: `Re: ${args.reference} · 10X`,
      html: template({
        preheader: `We replied to your message ${args.reference}.`,
        label: 'Support reply',
        title,
        body: quote(args.reply) + paragraph(`Reference ${escapeHtml(args.reference)}. Reply to this email if you need anything else.`),
        action,
        footer: 'Reply to this email to continue the conversation.',
      }),
      text: plain(title, [args.reply, `Reference: ${args.reference}`], action),
      replyTo: (await getSettings()).store.supportEmail,
    });
  },

  async emailChangeCode(args: { email: string; name: string; code: string }) {
    const title = 'Confirm your new email.';
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: `${args.code} is your 10X code`,
      html: template({
        preheader: `Your 10X confirmation code is ${args.code}.`,
        label: 'Security code',
        title,
        body: focusValue('Confirmation code', args.code, 'Expires in 15 minutes') + paragraph('If you did not request this change, you can ignore this email.'),
        footer: 'Never share this code with anyone, including 10X support.',
      }),
      text: plain(title, [`Code: ${args.code}`, 'Expires in 15 minutes.', 'If you did not request this change, ignore this email.']),
    });
  },

  async passwordReset(args: { email: string; name: string; token: string }) {
    const action = { label: 'Choose new password', href: `${env.storefrontUrl}/reset-password?token=${encodeURIComponent(args.token)}` };
    const title = 'Reset your password.';
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: 'Reset your 10X password',
      html: template({
        preheader: 'Your 10X password reset link is ready.',
        label: 'Password reset',
        title,
        body: paragraph('This secure link expires in 60 minutes. If you did not request it, no action is needed.'),
        action,
        footer: 'For your security, this link can be used only to reset your password.',
      }),
      text: plain(title, ['This secure link expires in 60 minutes.', 'If you did not request it, no action is needed.'], action),
    });
  },

  async teamInvite(args: { email: string; name: string; tempPassword: string; roleName: string }) {
    const action = { label: 'Open admin panel', href: env.adminUrl };
    const title = 'Your 10X admin account is ready.';
    return sendEmail({
      to: [{ email: args.email, name: args.name }],
      subject: 'Your 10X admin account',
      html: template({
        preheader: `You now have ${args.roleName} access to the 10X admin panel.`,
        label: 'Team access',
        title,
        body: details([
          { label: 'Email', value: args.email },
          { label: 'Role', value: args.roleName },
        ]) + focusValue('Temporary password', args.tempPassword, 'Change this after your first sign-in'),
        action,
        footer: 'This account is for authorized 10X team members only.',
      }),
      text: plain(title, [`Email: ${args.email}`, `Role: ${args.roleName}`, `Temporary password: ${args.tempPassword}`, 'Change it after your first sign-in.'], action),
    });
  },
};
