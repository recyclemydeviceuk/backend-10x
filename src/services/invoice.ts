import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { OrderDoc } from '../models/Order';
import { getSettings } from '../models/Setting';

// =========================================================
// The invoice — one renderer for every surface, deliberately
// minimal: logo, number, who, what, total. The customer's
// account, the panel's print view and the panel's PDF all
// show THIS document. The logo is embedded base64 so the
// file survives printing, saving and forwarding offline.
// =========================================================

const ACCENT = '#6DE325';
const INK = '#101410';
const MUTED = '#6b716a';
const LINE = '#ececea';

let logoDataUri = '';
function logo(): string {
  if (!logoDataUri) {
    const file = readFileSync(join(__dirname, '../assets/10x-logo-black.png'));
    logoDataUri = `data:image/png;base64,${file.toString('base64')}`;
  }
  return logoDataUri;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const dateLong = (d: Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paymentLine(order: OrderDoc): string {
  if (order.paymentStatus === 'refunded') return 'Refunded';
  if (order.payment.provider === 'cashfree') return `Paid online${order.payment.method ? ` · ${order.payment.method.toUpperCase()}` : ''}`;
  return order.paymentStatus === 'paid' ? 'Paid on delivery' : 'Pay on delivery';
}

/**
 * Render the invoice as one self-contained, mobile-fluid HTML document.
 * `toolbar` adds the on-screen print bar (hidden in print).
 */
export async function renderInvoiceHtml(order: OrderDoc, opts: { toolbar?: boolean } = {}): Promise<string> {
  const settings = await getSettings();
  const store = settings.store;

  const itemRows = order.items
    .map(
      (item) => `
      <div class="row item">
        <div>
          <p class="name">${escapeHtml(item.name)}</p>
          <p class="sub">${item.quantity} × ${inr(item.unitPrice)}</p>
        </div>
        <p class="amount">${inr(item.unitPrice * item.quantity)}</p>
      </div>`,
    )
    .join('');

  const discountRow = order.discount
    ? `<div class="row"><p>Discount${order.couponCode ? ` · ${escapeHtml(order.couponCode)}` : ''}</p><p class="good">−${inr(order.discount)}</p></div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(order.invoiceNo || 'Invoice')} — 10X</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #f1f2ef; color: ${INK}; font-size: 14px; line-height: 1.5; }
  .toolbar { display: flex; justify-content: center; padding: 14px; }
  .toolbar button { cursor: pointer; border: 0; border-radius: 999px; padding: 10px 24px; font-size: 13px; font-weight: 700; background: ${INK}; color: #fff; }
  .sheet { width: 100%; max-width: 560px; margin: 0 auto 32px; background: #fff; }
  .bar { height: 6px; background: ${ACCENT}; }
  .inner { padding: clamp(24px, 6vw, 44px); }

  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .head img { height: 30px; width: auto; display: block; }
  .doc { text-align: right; }
  .doc .label { font-size: 10px; letter-spacing: 2.5px; color: ${MUTED}; }
  .doc .no { font-size: 15px; font-weight: 800; margin-top: 1px; }
  .meta { margin-top: 6px; font-size: 12px; color: ${MUTED}; text-align: right; }

  .to { margin-top: 28px; font-size: 13px; color: ${MUTED}; }
  .to .who { font-weight: 700; color: ${INK}; font-size: 14px; }

  .items { margin-top: 24px; border-top: 2px solid ${INK}; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 11px 0; }
  .row.item { border-bottom: 1px solid ${LINE}; }
  .name { font-weight: 700; }
  .sub { font-size: 12px; color: ${MUTED}; margin-top: 1px; }
  .amount { font-weight: 700; white-space: nowrap; }
  .row p:first-child { color: ${MUTED}; }
  .row .good { color: #3f8f0d; font-weight: 700; }
  .row p:last-child { white-space: nowrap; }

  .total { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 6px; padding-top: 14px; border-top: 2px solid ${INK}; }
  .total .t { font-size: 12px; letter-spacing: 2px; font-weight: 700; }
  .total .v { font-size: 22px; font-weight: 800; background: ${ACCENT}; padding: 1px 10px; }
  .paid { margin-top: 10px; text-align: right; font-size: 12px; color: ${MUTED}; }

  footer { margin-top: 36px; padding-top: 14px; border-top: 1px solid ${LINE}; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 11px; color: ${MUTED}; }

  @media print {
    body { background: #fff; }
    .toolbar { display: none; }
    .sheet { max-width: none; margin: 0; }
  }
  @page { size: A4; margin: 14mm; }
</style>
</head>
<body>
${opts.toolbar ? `<div class="toolbar"><button onclick="window.print()">Print / Save PDF</button></div>` : ''}
<div class="sheet">
  <div class="bar"></div>
  <div class="inner">
    <div class="head">
      <img src="${logo()}" alt="10X" width="76" height="30" />
      <div class="doc">
        <p class="label">INVOICE</p>
        <p class="no">${escapeHtml(order.invoiceNo || order.reference)}</p>
        <p class="meta">${dateLong(order.placedAt)} · Order ${escapeHtml(order.reference)}</p>
      </div>
    </div>

    <div class="to">
      <p class="who">${escapeHtml(order.address.fullName || order.customerName)}</p>
      <p>${escapeHtml([order.address.line1, order.address.line2].filter(Boolean).join(', '))}</p>
      <p>${escapeHtml(`${order.address.city}, ${order.address.state} ${order.address.pincode}`)}</p>
    </div>

    <div class="items">
      ${itemRows}
      ${order.discount || order.shippingFee ? `<div class="row"><p>Subtotal</p><p>${inr(order.subtotal)}</p></div>` : ''}
      ${discountRow}
      <div class="row"><p>Delivery</p><p>${order.shippingFee ? inr(order.shippingFee) : 'Free'}</p></div>
    </div>

    <div class="total">
      <p class="t">TOTAL</p>
      <p class="v">${inr(order.total)}</p>
    </div>
    <p class="paid">${escapeHtml(paymentLine(order))}</p>

    <footer>
      <p>${escapeHtml(store.name)} · ${escapeHtml(store.supportEmail)}</p>
      <p>Computer-generated · no signature required</p>
    </footer>
  </div>
  <div class="bar"></div>
</div>
</body>
</html>`;
}
