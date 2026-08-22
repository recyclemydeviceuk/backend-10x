import { Types } from 'mongoose';
import { Order } from '../models/Order';
import { Customer } from '../models/Customer';
import { Product } from '../models/Product';
import { Coupon } from '../models/Coupon';
import { Subscription } from '../models/Subscription';
import { ReturnRequest } from '../models/ReturnRequest';
import { Event } from '../models/Event';
import { CustomerQuery } from '../models/Query';
import { CartSession } from '../models/CartSession';
import { getSettings } from '../models/Setting';
import { nextOrderReference, nextQueryReference, nextReturnReference, nextSeq } from '../models/Counter';

// =========================================================
// PANEL BRIDGE — translation between the admin panel's JSON
// collection shapes and the Mongo models.
//
// The panel reads a whole collection, edits the array in
// memory and writes it back. That contract is preserved here:
// `load` renders a collection in panel shape, `save` reconciles
// an incoming array against the database (upsert what's there,
// delete what isn't).
//
// Writes are `$set` of MAPPED FIELDS ONLY. Anything the panel
// never sees — a customer's password hash, a Cashfree payment
// session, timestamps — survives a round trip untouched.
// =========================================================

type Json = Record<string, unknown>;

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown): boolean => Boolean(v);

const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
/** ISO string, falling back to now — for fields the panel types as required. */
const isoOr = (v: unknown, fallback = new Date().toISOString()): string => iso(v) ?? fallback;

const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

const isOid = (v: unknown): boolean => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v);
const asOid = (v: unknown): Types.ObjectId => (isOid(v) ? new Types.ObjectId(v as string) : new Types.ObjectId());
/** Reference to another document: keep it if it's real, else null. */
const refOid = (v: unknown): Types.ObjectId | null => (isOid(v) ? new Types.ObjectId(v as string) : null);

/* ------------------------------------------------------------- timeline */

const ORDER_STAGES = ['placed', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered'] as const;

/**
 * The database keeps only stages that actually happened. Both UIs render a
 * full journey with unreached stages greyed out, so expand on the way out and
 * drop the blanks on the way back in.
 */
function expandTimeline(entries: { stage: string; at: Date }[]) {
  const at = new Map(entries.map((e) => [e.stage, iso(e.at)]));
  const stages = ORDER_STAGES.map((stage) => ({ stage, at: at.get(stage) ?? null }));
  const terminal = entries
    .filter((e) => !ORDER_STAGES.includes(e.stage as (typeof ORDER_STAGES)[number]))
    .map((e) => ({ stage: e.stage, at: iso(e.at) }));
  return [...stages, ...terminal];
}

function collapseTimeline(entries: unknown): { stage: string; at: Date }[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => e as Json)
    .filter((e) => e && e.at)
    .map((e) => ({ stage: str(e.stage), at: toDate(e.at) as Date }))
    .filter((e) => e.stage && e.at);
}

function notesOut(notes: unknown) {
  if (!Array.isArray(notes)) return [];
  return notes.map((n) => {
    const note = n as Json;
    return { by: str(note.by), at: isoOr(note.at), text: str(note.text) };
  });
}

function notesIn(notes: unknown) {
  if (!Array.isArray(notes)) return [];
  return notes
    .map((n) => n as Json)
    .filter((n) => n && n.text)
    .map((n) => ({ by: str(n.by) || 'Admin', text: str(n.text), at: toDate(n.at) ?? new Date() }));
}

/* --------------------------------------------------------------- orders */

function orderOut(o: InstanceType<typeof Order>) {
  const shipment = o.shipment ?? ({} as NonNullable<typeof o.shipment>);
  const hasShipment = Boolean(shipment.shipmentId || shipment.awb || shipment.provider || shipment.courier);
  const payment = o.payment ?? ({} as NonNullable<typeof o.payment>);

  return {
    id: o.id,
    reference: o.reference,
    invoiceNo: o.invoiceNo || undefined,
    placedAt: isoOr(o.placedAt),
    status: o.status,
    customerId: str(o.customerId),
    customerName: o.customerName,
    customerEmail: o.customerEmail,
    items: o.items.map((i) => ({
      sku: i.sku || '',
      name: i.name,
      packets: i.packets || '',
      quantity: i.quantity,
      price: i.unitPrice,
      // Carried through so a panel edit doesn't lose the catalogue linkage
      // that stock decrements and subscriptions depend on.
      productId: str(i.productId),
      tierId: i.tierId,
      tierName: i.tierName || '',
      subscribe: Boolean(i.subscribe),
    })),
    subtotal: o.subtotal,
    shipping: o.shippingFee,
    discount: o.discount,
    couponCode: o.couponCode || undefined,
    total: o.total,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    payment: {
      provider: payment.provider || (o.paymentMethod === 'cod' ? 'cod' : 'cashfree'),
      cfOrderId: o.cashfree?.orderId || undefined,
      cfPaymentId: o.cashfree?.paymentId || undefined,
      method: payment.method || undefined,
      capturedAt: iso(payment.capturedAt) ?? undefined,
      refunds: (payment.refunds ?? []).map((r) => ({
        refundId: r.refundId,
        amount: r.amount,
        at: isoOr(r.at),
        note: r.note || undefined,
      })),
    },
    address: {
      fullName: o.address.fullName || o.customerName,
      phone: o.address.phone || '',
      house: o.address.line1,
      street: o.address.line2 || '',
      landmark: o.address.landmark || undefined,
      city: o.address.city,
      state: o.address.state,
      pincode: o.address.pincode,
    },
    timeline: expandTimeline(o.timeline as { stage: string; at: Date }[]),
    shipment: hasShipment
      ? {
          provider: shipment.provider || 'shiprocket',
          shipmentId: shipment.shipmentId || undefined,
          orderId: shipment.orderId || undefined,
          awb: shipment.awb || undefined,
          courier: shipment.courier || undefined,
          status: shipment.status || undefined,
          createdAt: isoOr(shipment.createdAt, isoOr(o.placedAt)),
          pickupRequestedAt: iso(shipment.pickupRequestedAt) ?? undefined,
          labelUrl: shipment.labelUrl || undefined,
          invoiceUrl: shipment.invoiceUrl || undefined,
          lastSyncedAt: iso(shipment.lastSyncedAt) ?? undefined,
        }
      : undefined,
    courier: o.courier || undefined,
    trackingNumber: o.trackingNumber || undefined,
    estimatedDelivery: iso(o.estimatedDelivery) ?? undefined,
    subscriptionId: o.subscriptionId ? str(o.subscriptionId) : undefined,
    channel: o.channel,
    notes: notesOut(o.notes),
  };
}

function orderIn(p: Json): Json {
  const address = (p.address ?? {}) as Json;
  const payment = (p.payment ?? {}) as Json;
  const shipment = (p.shipment ?? {}) as Json;
  const items = Array.isArray(p.items) ? (p.items as Json[]) : [];

  return {
    reference: str(p.reference),
    customerId: refOid(p.customerId),
    customerName: str(p.customerName),
    customerEmail: str(p.customerEmail).toLowerCase(),
    items: items.map((i) => ({
      productId: refOid(i.productId),
      tierId: str(i.tierId),
      sku: str(i.sku),
      name: str(i.name),
      tierName: str(i.tierName),
      packets: str(i.packets),
      quantity: num(i.quantity, 1),
      unitPrice: num(i.price),
      subscribe: bool(i.subscribe),
    })),
    subtotal: num(p.subtotal),
    discount: num(p.discount),
    shippingFee: num(p.shipping),
    total: num(p.total),
    couponCode: str(p.couponCode),
    channel: p.channel === 'subscription' ? 'subscription' : 'website',
    paymentMethod: p.paymentMethod === 'online' ? 'online' : 'cod',
    paymentStatus: str(p.paymentStatus) || 'pending',
    status: str(p.status) || 'placed',
    address: {
      fullName: str(address.fullName),
      line1: str(address.house),
      line2: str(address.street),
      landmark: str(address.landmark),
      city: str(address.city),
      state: str(address.state),
      pincode: str(address.pincode),
      phone: str(address.phone),
    },
    timeline: collapseTimeline(p.timeline),
    notes: notesIn(p.notes),
    payment: {
      provider: str(payment.provider) === 'cashfree' ? 'cashfree' : str(payment.provider) === 'cod' ? 'cod' : '',
      method: str(payment.method),
      capturedAt: toDate(payment.capturedAt),
      refunds: (Array.isArray(payment.refunds) ? (payment.refunds as Json[]) : []).map((r) => ({
        refundId: str(r.refundId),
        amount: num(r.amount),
        at: toDate(r.at) ?? new Date(),
        note: str(r.note),
      })),
    },
    'cashfree.orderId': str(payment.cfOrderId),
    'cashfree.paymentId': str(payment.cfPaymentId),
    shipment: {
      provider: str(shipment.provider) === 'manual' ? 'manual' : shipment.provider ? 'shiprocket' : '',
      shipmentId: str(shipment.shipmentId),
      orderId: str(shipment.orderId),
      awb: str(shipment.awb),
      courier: str(shipment.courier),
      status: str(shipment.status),
      createdAt: toDate(shipment.createdAt),
      pickupRequestedAt: toDate(shipment.pickupRequestedAt),
      labelUrl: str(shipment.labelUrl),
      invoiceUrl: str(shipment.invoiceUrl),
      lastSyncedAt: toDate(shipment.lastSyncedAt),
    },
    courier: str(p.courier),
    trackingNumber: str(p.trackingNumber),
    invoiceNo: str(p.invoiceNo),
    estimatedDelivery: toDate(p.estimatedDelivery),
    subscriptionId: refOid(p.subscriptionId),
    placedAt: toDate(p.placedAt) ?? new Date(),
  };
}

/* ------------------------------------------------------------ customers */

function customerOut(c: InstanceType<typeof Customer>, lastOrderAt: string | null) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone || '',
    joinedAt: isoOr((c as unknown as { createdAt?: Date }).createdAt),
    city: c.city || '',
    state: c.state || '',
    ordersCount: c.ordersCount,
    totalSpent: c.totalSpent,
    lastOrderAt,
    hasSubscription: c.hasSubscription,
    marketingOptIn: c.marketingOptIn,
    addresses: (c.addresses ?? []).map((a) => ({
      id: str(a._id),
      label: a.label || 'Home',
      fullName: a.fullName || c.name,
      phone: a.phone || c.phone || '',
      house: a.line1,
      street: a.line2 || '',
      landmark: a.landmark || '',
      city: a.city,
      state: a.state,
      pincode: a.pincode,
      isDefault: Boolean(a.isDefault),
    })),
  };
}

function customerIn(p: Json): Json {
  const addresses = Array.isArray(p.addresses) ? (p.addresses as Json[]) : null;
  const doc: Json = {
    name: str(p.name),
    email: str(p.email).toLowerCase(),
    phone: str(p.phone),
    city: str(p.city),
    state: str(p.state),
    marketingOptIn: bool(p.marketingOptIn),
    hasSubscription: bool(p.hasSubscription),
    ordersCount: num(p.ordersCount),
    totalSpent: num(p.totalSpent),
  };
  // Only touch the address book when the panel actually sent one.
  if (addresses) {
    doc.addresses = addresses.map((a) => ({
      _id: asOid(a.id),
      label: str(a.label) || 'Home',
      fullName: str(a.fullName),
      line1: str(a.house),
      line2: str(a.street),
      landmark: str(a.landmark),
      city: str(a.city),
      state: str(a.state),
      pincode: str(a.pincode),
      phone: str(a.phone),
      isDefault: bool(a.isDefault),
    }));
  }
  return doc;
}

/* ------------------------------------------------------------- products */

function productOut(p: InstanceType<typeof Product>) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    tagline: p.tagline || '',
    description: p.description || '',
    status: p.status,
    images: p.images ?? [],
    imagesDark: p.imagesDark ?? [],
    video: p.video || undefined,
    tiers: (p.tiers ?? []).map((t) => ({
      id: str(t._id),
      name: t.name,
      packets: t.packets,
      oneTimePrice: t.oneTimePrice,
      subscribePrice: t.subscribePrice,
      available: t.available,
      stock: t.stock,
      lowStockAt: t.lowStockAt,
    })),
    seo: { title: p.seo?.title ?? '', description: p.seo?.description ?? '' },
    storefront: p.storefront,
    updatedAt: isoOr((p as unknown as { updatedAt?: Date }).updatedAt),
  };
}

function productIn(p: Json): Json {
  const tiers = Array.isArray(p.tiers) ? (p.tiers as Json[]) : [];
  const seo = (p.seo ?? {}) as Json;
  const sf = (p.storefront ?? {}) as Json;
  return {
    slug: str(p.slug).toLowerCase(),
    name: str(p.name),
    tagline: str(p.tagline),
    description: str(p.description),
    status: ['active', 'draft', 'archived'].includes(str(p.status)) ? str(p.status) : 'draft',
    images: Array.isArray(p.images) ? (p.images as unknown[]).map(str) : [],
    imagesDark: Array.isArray(p.imagesDark) ? (p.imagesDark as unknown[]).map(str) : [],
    video: str(p.video),
    tiers: tiers.map((t) => ({
      _id: asOid(t.id),
      name: str(t.name),
      packets: num(t.packets, 1),
      oneTimePrice: num(t.oneTimePrice),
      subscribePrice: num(t.subscribePrice),
      stock: num(t.stock),
      lowStockAt: num(t.lowStockAt, 10),
      available: bool(t.available),
    })),
    seo: { title: str(seo.title), description: str(seo.description) },
    storefront: {
      kicker: str(sf.kicker),
      subscriptionNote: str(sf.subscriptionNote),
      priceNote: str(sf.priceNote),
      subscribePriceNote: str(sf.subscribePriceNote),
      ctaLabel: str(sf.ctaLabel),
      perfectFor: str(sf.perfectFor),
      benefits: Array.isArray(sf.benefits) ? (sf.benefits as unknown[]).map(str) : [],
    },
  };
}

/* -------------------------------------------------------------- coupons */

function couponOut(c: InstanceType<typeof Coupon>) {
  return {
    id: c.id,
    code: c.code,
    description: c.description || '',
    type: c.type,
    value: c.value,
    minOrder: c.minOrderValue,
    maxDiscount: c.maxDiscount ?? undefined,
    usageLimit: c.usageLimit ?? null,
    usedCount: c.usedCount,
    perCustomerLimit: c.perCustomerLimit ?? null,
    startsAt: isoOr(c.startsAt, isoOr((c as unknown as { createdAt?: Date }).createdAt)),
    expiresAt: iso(c.expiresAt),
    active: c.active,
    createdBy: c.createdBy || '',
  };
}

function couponIn(p: Json): Json {
  return {
    code: str(p.code).toUpperCase(),
    description: str(p.description),
    type: p.type === 'flat' ? 'flat' : 'percent',
    value: num(p.value, 1),
    minOrderValue: num(p.minOrder),
    maxDiscount: p.maxDiscount == null ? null : num(p.maxDiscount),
    usageLimit: p.usageLimit == null ? null : num(p.usageLimit),
    perCustomerLimit: p.perCustomerLimit == null ? null : num(p.perCustomerLimit),
    usedCount: num(p.usedCount),
    startsAt: toDate(p.startsAt),
    expiresAt: toDate(p.expiresAt),
    active: bool(p.active),
    createdBy: str(p.createdBy),
  };
}

/* -------------------------------------------------------- subscriptions */

/** "Every 4 weeks" ⇄ 28 days. Anything unparseable keeps the 4-week default. */
function cadenceLabel(days: number): string {
  if (days % 7 === 0) {
    const weeks = days / 7;
    return weeks === 1 ? 'Every week' : `Every ${weeks} weeks`;
  }
  return days === 1 ? 'Every day' : `Every ${days} days`;
}

function cadenceDays(label: string): number {
  const text = label.toLowerCase();
  const match = text.match(/(\d+)\s*(day|week|month)/);
  if (!match) return /week/.test(text) ? 7 : 28;
  const n = Number(match[1]);
  if (match[2] === 'week') return n * 7;
  if (match[2] === 'month') return n * 30;
  return n;
}

function subscriptionOut(s: InstanceType<typeof Subscription>) {
  return {
    id: s.id,
    reference: s.reference,
    customerId: str(s.customerId),
    customerName: s.customerName || '',
    sku: s.sku || '',
    productName: s.planName,
    packets: s.packets || '',
    price: s.price,
    cadence: cadenceLabel(s.intervalDays),
    status: s.status,
    startedAt: isoOr(s.startedAt),
    nextDelivery: iso(s.nextDelivery),
    cyclesDelivered: s.cyclesDelivered,
    // Kept so a panel round trip doesn't strip the catalogue linkage the
    // subscription worker needs to raise the next cycle order.
    productId: str(s.productId),
    tierId: s.tierId,
    quantity: s.quantity,
    // Read-only in the panel: the mandate lives with Cashfree.
    autopay: s.autopay?.status || 'off',
    autopayLastCharge: s.autopay?.lastChargeStatus || '',
    autopayDeclined: Boolean(s.autopay?.declinedAt),
    autopayReminders: s.autopay?.reminderCount || 0,
    autopayLastReminderAt: iso(s.autopay?.lastReminderAt ?? null),
  };
}

function subscriptionIn(p: Json): Json {
  return {
    reference: str(p.reference),
    customerId: refOid(p.customerId),
    customerName: str(p.customerName),
    productId: refOid(p.productId),
    tierId: str(p.tierId),
    sku: str(p.sku),
    packets: str(p.packets),
    planName: str(p.productName),
    quantity: num(p.quantity, 1),
    price: num(p.price),
    intervalDays: cadenceDays(str(p.cadence)),
    status: ['active', 'paused', 'cancelled'].includes(str(p.status)) ? str(p.status) : 'active',
    nextDelivery: toDate(p.nextDelivery),
    cyclesDelivered: num(p.cyclesDelivered),
    startedAt: toDate(p.startedAt) ?? new Date(),
  };
}

/* -------------------------------------------------------------- returns */

function returnOut(r: InstanceType<typeof ReturnRequest>) {
  const sr = r.shiprocket ?? ({} as NonNullable<typeof r.shiprocket>);
  const hasPickup = Boolean(sr.orderId || sr.shipmentId || sr.awb);
  const refund = r.refund ?? ({} as NonNullable<typeof r.refund>);
  return {
    id: r.id,
    reference: r.reference,
    orderId: str(r.orderId),
    orderReference: r.orderReference,
    customerId: str(r.customerId),
    customerName: r.customerName,
    customerEmail: r.customerEmail,
    reason: r.reason,
    description: r.description,
    photos: r.photos ?? [],
    status: r.status,
    requestedAt: isoOr((r as unknown as { createdAt?: Date }).createdAt),
    amount: r.amount,
    paymentMethod: r.isPrepaid ? 'online' : 'cod',
    pickup: hasPickup
      ? {
          srOrderId: sr.orderId || undefined,
          shipmentId: sr.shipmentId || undefined,
          awb: sr.awb || undefined,
          courier: sr.courier || undefined,
          scheduledAt: iso(sr.scheduledAt) ?? undefined,
        }
      : undefined,
    refund: refund.mode
      ? { refundId: refund.refundId || undefined, at: isoOr(refund.at), mode: refund.mode }
      : undefined,
    rejectReason: r.rejectReason || undefined,
    resolvedAt: iso(r.resolvedAt) ?? undefined,
    notes: notesOut(r.notes),
  };
}

function returnIn(p: Json): Json {
  const pickup = (p.pickup ?? {}) as Json;
  const refund = (p.refund ?? {}) as Json;
  return {
    reference: str(p.reference),
    orderId: refOid(p.orderId),
    orderReference: str(p.orderReference),
    customerId: refOid(p.customerId),
    customerName: str(p.customerName),
    customerEmail: str(p.customerEmail).toLowerCase(),
    reason: str(p.reason),
    description: str(p.description),
    photos: Array.isArray(p.photos) ? (p.photos as unknown[]).map(str) : [],
    amount: num(p.amount),
    isPrepaid: p.paymentMethod === 'online',
    status: str(p.status) || 'requested',
    rejectReason: str(p.rejectReason),
    resolvedAt: toDate(p.resolvedAt),
    shiprocket: {
      orderId: str(pickup.srOrderId),
      shipmentId: str(pickup.shipmentId),
      awb: str(pickup.awb),
      courier: str(pickup.courier),
      scheduledAt: toDate(pickup.scheduledAt),
    },
    refund: {
      mode: refund.mode === 'cashfree' ? 'cashfree' : refund.mode === 'manual' ? 'manual' : '',
      refundId: str(refund.refundId),
      at: toDate(refund.at),
    },
    notes: notesIn(p.notes),
  };
}

/* -------------------------------------------------------------- queries */

function queryOut(q: InstanceType<typeof CustomerQuery>) {
  return {
    id: q.id,
    reference: q.reference,
    topic: q.topic,
    name: q.name,
    email: q.email,
    phone: q.phone || '',
    orderReference: q.orderReference || '',
    message: q.message,
    status: q.status,
    submittedAt: isoOr((q as unknown as { createdAt?: Date }).createdAt),
    reply: q.reply || '',
    answeredAt: iso(q.answeredAt),
    answeredBy: q.answeredBy || '',
  };
}

function queryIn(p: Json): Json {
  return {
    reference: str(p.reference),
    topic: str(p.topic) || 'other',
    name: str(p.name),
    email: str(p.email).toLowerCase(),
    phone: str(p.phone),
    orderReference: str(p.orderReference),
    message: str(p.message),
    status: str(p.status) || 'new',
    reply: str(p.reply),
    answeredAt: toDate(p.answeredAt),
    answeredBy: str(p.answeredBy),
  };
}

/* --------------------------------------------------------------- events */

function eventOut(e: InstanceType<typeof Event>) {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    message: e.message || '',
    href: e.href || '',
    at: isoOr((e as unknown as { createdAt?: Date }).createdAt),
  };
}

/**
 * Map a list of documents and stamp each with the version it was read at.
 *
 * `_v` travels out to the panel and back on the next write, which is what lets
 * the bridge tell "this is the record I edited" from "someone else moved it".
 */
function versioned<D extends { updatedAt?: Date }>(docs: D[], map: (d: D) => Json): Json[] {
  return docs.map((d) => ({ ...map(d), _v: iso(d.updatedAt) }));
}

/* ============================================================ reconcile */

/** Raised when a document changed underneath the panel between read and write. */
export class WriteConflict extends Error {
  constructor(public readonly references: string[]) {
    super(
      references.length === 1
        ? `${references[0]} was changed by someone else while you were editing. Reload and try again.`
        : `${references.length} records were changed by someone else while you were editing (${references
            .slice(0, 3)
            .join(', ')}${references.length > 3 ? '…' : ''}). Reload and try again.`,
    );
    this.name = 'WriteConflict';
  }
}

/** Something to name the conflicting record by in that message. */
const labelOf = (panel: Json): string =>
  str(panel.reference) || str(panel.code) || str(panel.name) || str(panel.email) || str(panel.id);

/**
 * Apply an incoming panel array to a collection: update what exists, insert
 * what's new, delete what the panel dropped.
 *
 * TWO SAFETY RAILS, because the panel is a team tool and this write carries a
 * whole collection:
 *
 *  - `knownIds` is what the writer actually SAW when they read. Deletions are
 *    limited to that set, so an order someone else created a moment ago isn't
 *    wiped out by a colleague who is only adding a note to a different one.
 *  - `_v` is each document's `updatedAt` at read time. A document that has
 *    moved on since is NOT overwritten; the whole write is rejected with a
 *    message naming what changed. Losing an edit silently is worse than
 *    asking someone to reload.
 *
 * Inserts keep the panel's id when it is a real ObjectId — `newId()` in the
 * panel mints one — so a "create then redirect to /orders/<id>" flow still
 * lands on the document that was just created.
 */
async function reconcile<M extends { updateOne: Function; create: Function; deleteMany: Function; find: Function }>(
  model: M,
  incoming: Json[],
  map: (p: Json) => Json,
  onInsert?: (doc: Json, panel: Json) => Promise<Json>,
  knownIds?: string[],
  /**
   * Narrower mapping for records that already exist. Where the panel only
   * ever edits a few fields (orders: notes), writing the whole document back
   * would overwrite what the server changed in the meantime — and bake
   * display fallbacks into the database.
   */
  updateMap?: (p: Json) => Json,
): Promise<void> {
  const seen: Types.ObjectId[] = [];
  const existingIds = new Set(
    (
      (await (model.find as (f: unknown, p: unknown) => { lean: () => Promise<{ _id: Types.ObjectId }[]> })(
        {},
        '_id',
      ).lean()) ?? []
    ).map((d) => String(d._id)),
  );

  // Check every version BEFORE writing anything, so a conflict can't leave the
  // collection half-applied.
  const conflicts: string[] = [];
  for (const panel of incoming) {
    const id = str(panel.id);
    if (!isOid(id) || !existingIds.has(id) || !panel._v) continue;
    const fresh = await (model.find as Function)({ _id: id }, 'updatedAt').lean();
    const current = iso((fresh as { updatedAt?: Date }[])[0]?.updatedAt);
    if (current && current !== str(panel._v)) conflicts.push(labelOf(panel));
  }
  if (conflicts.length) throw new WriteConflict(conflicts);

  for (const panel of incoming) {
    const id = str(panel.id);
    if (isOid(id) && existingIds.has(id)) {
      seen.push(new Types.ObjectId(id));
      await (model.updateOne as Function)({ _id: id }, { $set: (updateMap ?? map)(panel) });
    } else {
      const mapped = map(panel);
      const _id = asOid(id);
      seen.push(_id);
      const doc = onInsert ? await onInsert({ ...mapped, _id }, panel) : { ...mapped, _id };
      await (model.create as Function)(doc);
    }
  }

  // Delete only what this writer saw and then dropped. Without a read set
  // (an older client) fall back to the whole collection.
  const kept = new Set(seen.map(String));
  const deletable = knownIds
    ? knownIds.filter((id) => isOid(id) && !kept.has(id)).map((id) => new Types.ObjectId(id))
    : null;

  if (deletable) {
    if (deletable.length) await (model.deleteMany as Function)({ _id: { $in: deletable } });
  } else {
    await (model.deleteMany as Function)({ _id: { $nin: seen } });
  }
}

/* ============================================================ collections */

export const PANEL_COLLECTIONS = [
  'orders',
  'customers',
  'products',
  'coupons',
  'subscriptions',
  'returns',
  'queries',
  'settings',
  'events',
  'carts',
  'syncing',
] as const;

export type PanelCollection = (typeof PANEL_COLLECTIONS)[number];

export const isPanelCollection = (name: string): name is PanelCollection =>
  (PANEL_COLLECTIONS as readonly string[]).includes(name);

/* ------------------------------------------------------------ load side */

export async function loadCollection(name: PanelCollection): Promise<unknown> {
  switch (name) {
    case 'orders': {
      const orders = await Order.find({}).sort({ placedAt: -1 });
      return versioned(orders, orderOut);
    }
    case 'customers': {
      const customers = await Customer.find({}).sort({ createdAt: -1 });
      // One aggregate rather than a query per customer.
      const last = await Order.aggregate<{ _id: Types.ObjectId; at: Date }>([
        { $match: { status: { $ne: 'cancelled' } } },
        { $group: { _id: '$customerId', at: { $max: '$placedAt' } } },
      ]);
      const lastByCustomer = new Map(last.map((l) => [String(l._id), iso(l.at)]));
      return versioned(customers, (c) => customerOut(c, lastByCustomer.get(c.id) ?? null));
    }
    case 'products': {
      const products = await Product.find({}).sort({ createdAt: 1 });
      return versioned(products, productOut);
    }
    case 'coupons': {
      const coupons = await Coupon.find({}).sort({ createdAt: -1 });
      return versioned(coupons, couponOut);
    }
    case 'subscriptions': {
      const subs = await Subscription.find({}).sort({ startedAt: -1 });
      return versioned(subs, subscriptionOut);
    }
    case 'returns': {
      const returns = await ReturnRequest.find({}).sort({ createdAt: -1 });
      return versioned(returns, returnOut);
    }
    case 'queries': {
      const queries = await CustomerQuery.find({}).sort({ createdAt: -1 });
      return versioned(queries, queryOut);
    }
    case 'events': {
      const events = await Event.find({}).sort({ createdAt: -1 }).limit(200);
      return events.map(eventOut);
    }
    case 'settings':
      return loadSettings();
    case 'carts': {
      const carts = await CartSession.find({ customerId: { $ne: null }, line: { $ne: null } }).sort({ updatedAt: -1 }).lean();
      return carts.map((cart) => {
        const line = cart.line as Json;
        return {
          customerId: str(cart.customerId),
          updatedAt: isoOr((cart as unknown as { updatedAt?: Date }).updatedAt),
          items: [{
            sku: str(line.sku),
            name: str(line.productName),
            packets: str(line.packets),
            quantity: num(line.quantity, 1),
            price: num(line.price),
          }],
        };
      });
    }
    case 'syncing': {
      // The API's own worker writes this log, so the panel's Syncing tab
      // shows what actually ran rather than a separate history of its own.
      const s = await getSettings();
      return {
        lastRunAt: iso(s.automation.lastRunAt),
        log: s.automation.log.map((entry) => ({ at: isoOr(entry.at), text: entry.text })),
      };
    }
  }
}

/* ----------------------------------------------------------- save side */

export async function saveCollection(
  name: PanelCollection,
  data: unknown,
  knownIds?: string[],
): Promise<void> {
  const rows = Array.isArray(data) ? (data as Json[]) : [];

  switch (name) {
    case 'orders':
      return reconcile(
        Order,
        rows,
        orderIn,
        async (doc) => {
          // The panel mints its own reference from what it can see; the counter
          // is the real authority, so a collision gets a fresh one rather than
          // failing the write.
          if (!doc.reference || (await Order.exists({ reference: doc.reference }))) {
            doc.reference = await nextOrderReference();
          }
          return doc;
        },
        knownIds,
        // Existing orders: status, payment, shipment, stock and timeline are
        // all owned by the server's lifecycle routes. Notes are the one thing
        // the panel edits in place.
        (p) => ({ notes: notesIn(p.notes) }),
      );
    case 'customers':
      return reconcile(Customer, rows, customerIn, undefined, knownIds);
    case 'products':
      return reconcile(Product, rows, productIn, undefined, knownIds);
    case 'coupons':
      return reconcile(Coupon, rows, couponIn, undefined, knownIds);
    case 'subscriptions':
      return reconcile(Subscription, rows, subscriptionIn, async (doc) => {
        if (!doc.reference || (await Subscription.exists({ reference: doc.reference }))) {
          doc.reference = `SUB-${await nextSeq('subscription', 100)}`;
        }
        return doc;
      }, knownIds);
    case 'returns':
      return reconcile(ReturnRequest, rows, returnIn, async (doc) => {
        if (!doc.reference || (await ReturnRequest.exists({ reference: doc.reference }))) {
          doc.reference = await nextReturnReference();
        }
        return doc;
      }, knownIds);
    case 'queries':
      return reconcile(CustomerQuery, rows, queryIn, async (doc) => {
        if (!doc.reference || (await CustomerQuery.exists({ reference: doc.reference }))) {
          doc.reference = await nextQueryReference();
        }
        return doc;
      }, knownIds);
    case 'events': {
      // The feed is append-only from the panel's side: write the rows it
      // doesn't already know about and leave history alone.
      const known = new Set((await Event.find({}, '_id').lean()).map((e) => String(e._id)));
      for (const row of rows) {
        if (isOid(row.id) && known.has(str(row.id))) continue;
        await Event.create({
          _id: asOid(row.id),
          type: str(row.type) || 'order',
          title: str(row.title),
          message: str(row.message),
          href: str(row.href),
          createdAt: toDate(row.at) ?? new Date(),
        });
      }
      return;
    }
    case 'settings':
      return saveSettings((data ?? {}) as Json);
    case 'carts':
      // Read-only from the panel: the customer's own session owns their cart.
      return;
    case 'syncing':
      // Read-only from the panel: the worker owns this record.
      return;
  }
}

/* ------------------------------------------------------------- settings */

async function loadSettings() {
  const s = await getSettings();
  return {
    store: {
      name: s.store.name,
      supportEmail: s.store.supportEmail,
      supportPhone: s.store.supportPhone,
      comingSoonMode: s.store.comingSoonMode,
      deliveryMode: s.store.deliveryMode,
      freeShippingOver: s.store.freeShippingOver,
      flatShipping: s.store.flatShipping,
      codEnabled: s.store.codEnabled,
      subscriptionIntervalDays: s.store.subscriptionIntervalDays,
      autopayReminderEveryDays: s.store.autopayReminderEveryDays,
      autopayReminderMax: s.store.autopayReminderMax,
    },
    syncing: {
      autoShipments: s.automation.autoShipments,
      autoApproveReturns: s.automation.autoApproveReturns,
    },
    warehouse: {
      name: s.warehouse.name,
      address: s.warehouse.address,
      city: s.warehouse.city,
      state: s.warehouse.state,
      pincode: s.warehouse.pincode,
      phone: s.warehouse.phone,
    },
  };
}

async function saveSettings(p: Json): Promise<void> {
  const s = await getSettings();
  const store = (p.store ?? {}) as Json;
  const warehouse = (p.warehouse ?? {}) as Json;
  const syncing = (p.syncing ?? {}) as Json;

  if (p.store) {
    s.store.name = str(store.name) || s.store.name;
    s.store.supportEmail = str(store.supportEmail) || s.store.supportEmail;
    s.store.supportPhone = str(store.supportPhone);
    s.store.comingSoonMode = typeof store.comingSoonMode === 'boolean' ? store.comingSoonMode : s.store.comingSoonMode;
    s.store.deliveryMode = ['free', 'priced', 'live'].includes(str(store.deliveryMode)) ? (str(store.deliveryMode) as 'free' | 'priced' | 'live') : s.store.deliveryMode;
    s.store.freeShippingOver = num(store.freeShippingOver, s.store.freeShippingOver);
    s.store.flatShipping = num(store.flatShipping, s.store.flatShipping);
    s.store.codEnabled = bool(store.codEnabled);
    s.store.subscriptionIntervalDays = num(store.subscriptionIntervalDays, s.store.subscriptionIntervalDays);
    s.store.autopayReminderEveryDays = num(store.autopayReminderEveryDays, s.store.autopayReminderEveryDays);
    s.store.autopayReminderMax = num(store.autopayReminderMax, s.store.autopayReminderMax);
  }
  if (p.warehouse) {
    s.warehouse.name = str(warehouse.name);
    s.warehouse.address = str(warehouse.address);
    s.warehouse.city = str(warehouse.city);
    s.warehouse.state = str(warehouse.state);
    s.warehouse.pincode = str(warehouse.pincode);
    s.warehouse.phone = str(warehouse.phone);
  }
  if (p.syncing) {
    s.automation.autoShipments = bool(syncing.autoShipments);
    if (syncing.autoApproveReturns !== undefined) s.automation.autoApproveReturns = bool(syncing.autoApproveReturns);
  }
  await s.save();

}
