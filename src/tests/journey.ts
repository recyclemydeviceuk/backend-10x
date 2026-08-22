/* eslint-disable no-console */
// =========================================================
// CROSS-SURFACE JOURNEY
//
// One customer, one order, from the storefront's first request
// to the refund landing back on their card — with the admin
// panel driving the middle of it through its own data layer.
//
// The journey exercises the same authenticated API contracts used by the
// storefront and admin panel. If this passes, the three surfaces agree.
//
// Run: npm run journey
// =========================================================

process.env.MONGODB_URI = 'mongodb://placeholder'; // replaced below
process.env.JWT_SECRET = 'journey-test-secret';
process.env.ADMIN_JWT_SECRET = 'journey-test-admin-secret';
process.env.ADMIN_NAME = 'Environment Owner';
process.env.ADMIN_EMAIL = 'founder@10xdrink.com';
process.env.ADMIN_PASSWORD = 'TakeCharge10x!';
process.env.NODE_ENV = 'test';

import { MongoMemoryServer } from 'mongodb-memory-server';

async function main() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();

  const { connectDb, disconnectDb } = await import('../db/connect');
  const { createApp } = await import('../app');
  const { env } = await import('../config/env');
  const { Product } = await import('../models/Product');
  const { Coupon } = await import('../models/Coupon');
  const { getSettings } = await import('../models/Setting');

  await connectDb(mongod.getUri());
  const app = createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, extra: unknown = '') => {
    if (ok) {
      passed++;
      console.log(`  PASS ${name}`);
    } else {
      failed++;
      console.error(`  FAIL ${name} ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 300)}`);
    }
  };

  /* ------------------------------------------------- the three surfaces */

  /** What the storefront browser does. */
  const shop = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    const session = decodeURIComponent(cookie.match(/10x_customer_session=([^;]+)/)?.[1] ?? '');
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any, session };
  };

  let panelToken = '';
  /** What admin panel/lib/db.ts does. */
  const panelRead = async (name: string) => {
    const res = await fetch(`${base}/api/v1/admin/collections/${name}`, {
      headers: { authorization: `Bearer ${panelToken}` },
    });
    const body = (await res.json()) as { data: any };
    return body.data;
  };
  const panelWrite = async (name: string, data: unknown) => {
    const res = await fetch(`${base}/api/v1/admin/collections/${name}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${panelToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    return res.status;
  };

  /* ---------------------------------------------------------------- seed */

  await Product.create({
    slug: '10x-daytime',
    name: '10X Daytime',
    description: 'Whole-food energy.',
    status: 'active',
    storefront: { kicker: '10X Day Time —', ctaLabel: 'Add to Cart', benefits: ['Calm focus'] },
    tiers: [
      { name: 'Single Pack', packets: 10, oneTimePrice: 1199, subscribePrice: 1049, stock: 40, lowStockAt: 5, available: true },
      { name: 'Trial Pack', packets: 3, oneTimePrice: 399, subscribePrice: 349, stock: 2, lowStockAt: 1, available: true },
    ],
  });
  const settings = await getSettings();
  settings.store.freeShippingOver = 3000;
  settings.store.flatShipping = 49;
  settings.warehouse.address = '1 Warehouse Road';
  settings.warehouse.pincode = '400001';
  await settings.save();
  await Coupon.create({
    code: 'BRAIN100',
    description: '₹100 off orders over ₹999',
    type: 'flat',
    value: 100,
    minOrderValue: 999,
    active: true,
  });
  const adminLogin = await fetch(`${base}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  panelToken = ((await adminLogin.json()) as { token: string }).token;

  console.log('\nstorefront — catalogue');

  /* --------------------------------------------- 1. the product page */

  const catalogue = await shop('/products/10x-daytime');
  const product = catalogue.body.product;
  const tier = product?.tiers?.[0];
  const trialTier = product?.tiers?.[1];
  check(
    'product page gets the pack, its price and its stock',
    catalogue.status === 200 && tier?.oneTimePrice === 1199 && tier?.inStock === true && tier?.stock === 40,
    tier,
  );
  check(
    'admin-managed hero copy reaches the storefront',
    product?.storefront?.kicker === '10X Day Time —' && product?.storefront?.benefits?.[0] === 'Calm focus',
    product?.storefront,
  );

  const storeSettings = await shop('/settings');
  check(
    'the cart reads the store’s real shipping rule',
    storeSettings.body.settings?.freeShippingOver === 3000 && storeSettings.body.settings?.flatShipping === 49,
    storeSettings.body.settings,
  );

  const featured = await shop('/coupons/featured');
  check(
    'promoted codes come from the store’s own coupons',
    featured.body.coupons?.[0]?.code === 'BRAIN100' && featured.body.coupons?.[0]?.label === '₹100 off orders over ₹999',
    featured.body.coupons,
  );

  console.log('\nstorefront — account + cart');

  /* --------------------------------------------------- 2. the customer */

  const registered = await shop('/auth/register', {
    method: 'POST',
    body: { name: 'Arjun Mehta', email: 'arjun@example.com', password: 'take-charge-10x', phone: '9876543210' },
  });
  const token = registered.session;
  check('signing up returns a session', registered.status === 201 && Boolean(token));

  const savedAddress = await shop('/auth/me', {
    method: 'PATCH',
    token,
    body: {
      addresses: [
        {
          label: 'Home',
          fullName: 'Arjun Mehta',
          line1: 'Flat 902, Tower B',
          line2: 'Senapati Bapat Road',
          landmark: 'Near Kamala Mills',
          city: 'Mumbai',
          state: 'Maharashtra',
          pincode: '400013',
          phone: '9876543210',
          isDefault: true,
        },
      ],
    },
  });
  check(
    'the address book keeps every field the checkout form collects',
    savedAddress.body.customer?.addresses?.[0]?.landmark === 'Near Kamala Mills' &&
      savedAddress.body.customer?.addresses?.[0]?.isDefault === true,
    savedAddress.body.customer?.addresses,
  );

  const couponTooSmall = await shop('/coupons/validate', { method: 'POST', body: { code: 'BRAIN100', subtotal: 500 } });
  check(
    'a coupon below its minimum says how much more is needed',
    couponTooSmall.status === 400 && /Add ₹499 more/.test(String(couponTooSmall.body.message)),
    couponTooSmall.body,
  );

  const couponOk = await shop('/coupons/validate', { method: 'POST', body: { code: 'BRAIN100', subtotal: 2398 } });
  check('the cart’s discount is the API’s own number', couponOk.body.discount === 100, couponOk.body);

  // The storefront persists the open cart in MongoDB so the panel can see
  // what a signed-in customer was considering.
  const mirrored = await shop('/cart', {
    method: 'PUT',
    token,
    body: {
      line: {
        productId: product.id,
        tierId: tier.id,
        sku: '10X-DAYTIME-10',
        productName: '10X Daytime',
        tierName: 'Single Pack',
        packets: '10 Stick Packets',
        image: '',
        quantity: 2,
        price: 1199,
        oneTimePrice: 1199,
        isSubscription: false,
      },
      couponCode: 'BRAIN100',
    },
  });
  const panelCarts = await panelRead('carts');
  check(
    'the customer’s live cart shows up in the panel',
    mirrored.status === 200 && panelCarts[0]?.items?.[0]?.quantity === 2 && panelCarts[0]?.items?.[0]?.name === '10X Daytime',
    panelCarts,
  );

  console.log('\nstorefront — checkout');

  /* ---------------------------------------------------- 3. the checkout */

  const address = {
    fullName: 'Arjun Mehta',
    line1: 'Flat 902, Tower B',
    line2: 'Senapati Bapat Road',
    landmark: 'Near Kamala Mills',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400013',
    phone: '9876543210',
  };

  const overSold = await shop('/checkout', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: product.id, tierId: trialTier.id, quantity: 3, subscribe: false }],
      address,
      paymentMethod: 'cod',
      couponCode: '',
    },
  });
  check(
    'stock is checked against the catalogue, not the cart',
    overSold.status === 400 && /only 2 left in stock/i.test(String(overSold.body.message)),
    overSold.body,
  );

  const badCoupon = await shop('/checkout', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: product.id, tierId: trialTier.id, quantity: 1, subscribe: false }],
      address,
      paymentMethod: 'cod',
      couponCode: 'BRAIN100',
    },
  });
  check(
    'a coupon under its minimum is refused at the checkout too, not just in the cart',
    badCoupon.status === 400 && /Add ₹600 more/.test(String(badCoupon.body.message)),
    badCoupon.body,
  );

  const placed = await shop('/checkout', {
    method: 'POST',
    token,
    body: {
      // A price sent by the browser is ignored — the API reads the catalogue.
      items: [{ productId: product.id, tierId: tier.id, quantity: 2, subscribe: false, unitPrice: 1 }],
      address,
      paymentMethod: 'cod',
      couponCode: 'BRAIN100',
    },
  });
  const orderRef = placed.body.order?.reference as string;
  check(
    'the total is computed server-side: 2 × 1199 − 100 coupon + 49 shipping',
    placed.status === 201 && placed.body.order?.total === 2398 - 100 + 49,
    placed.body.order,
  );

  const myOrders = await shop('/me/orders', { token });
  check(
    'the order appears on the customer’s account straight away',
    myOrders.body.orders?.[0]?.reference === orderRef &&
      myOrders.body.orders[0].address.landmark === 'Near Kamala Mills' &&
      myOrders.body.orders[0].items[0].sku.length > 0,
    myOrders.body.orders?.[0],
  );

  const stockAfter = await shop('/products/10x-daytime');
  check(
    'a confirmed COD order takes the stock down',
    stockAfter.body.product.tiers[0].stock === 38,
    stockAfter.body.product.tiers[0],
  );

  console.log('\nadmin panel — fulfilment');

  /* ------------------------------------------------------- 4. the panel */

  let panelOrders = await panelRead('orders');
  const panelOrder = panelOrders.find((o: any) => o.reference === orderRef);
  check(
    'the panel sees the storefront order in its own shape',
    Boolean(panelOrder) &&
      panelOrder.shipping === 49 &&
      panelOrder.discount === 100 &&
      panelOrder.address.house === 'Flat 902, Tower B' &&
      panelOrder.payment.provider === 'cod',
    panelOrder,
  );
  check(
    'the panel gets the catalogue linkage it needs to reorder',
    panelOrder.items[0].productId === product.id && panelOrder.items[0].tierId === tier.id,
    panelOrder.items[0],
  );

  const panelCustomers = await panelRead('customers');
  const panelCustomer = panelCustomers.find((c: any) => c.email === 'arjun@example.com');
  check(
    'the customer’s spend and address book reach the panel',
    panelCustomer?.ordersCount === 1 &&
      panelCustomer.totalSpent === 2347 &&
      panelCustomer.addresses?.[0]?.city === 'Mumbai',
    panelCustomer,
  );

  // The team packs and ships it, exactly as the panel's actions do: manual
  // tracking goes through the fulfilment route, status through the lifecycle
  // route. (The bridge no longer moves status — a stale panel tab must never
  // overwrite what the courier reported.)
  panelOrders = await panelRead('orders');
  const targetId = panelOrders.find((o: any) => o.reference === orderRef).id;
  const adminCall = (path: string, body: unknown, method = 'POST') =>
    fetch(`${base}/api/v1/admin/orders/${targetId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${panelToken}` },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as any }));
  await adminCall('/manual-tracking', { courier: 'Blue Dart', awb: 'BD4471902238' });
  await adminCall('/status', { status: 'packed' }, 'PATCH');
  await adminCall('/status', { status: 'shipped' }, 'PATCH');

  const shippedForCustomer = await shop(`/me/orders/${orderRef}`, { token });
  check(
    'the customer sees the courier and AWB the panel entered',
    shippedForCustomer.body.order?.status === 'shipped' &&
      shippedForCustomer.body.order.courier === 'Blue Dart' &&
      shippedForCustomer.body.order.trackingNumber === 'BD4471902238',
    shippedForCustomer.body.order,
  );
  check(
    'the timeline the customer sees matches the stages that happened',
    shippedForCustomer.body.order.timeline.map((t: any) => t.stage).join(',') ===
      'placed,confirmed,packed,shipped',
    shippedForCustomer.body.order.timeline,
  );

  const tooLateToCancel = await shop(`/me/orders/${orderRef}/cancel`, { method: 'POST', token });
  check(
    'a shipped order can’t be cancelled from the account',
    tooLateToCancel.status === 400 && /on its way/.test(String(tooLateToCancel.body.message)),
    tooLateToCancel.body,
  );

  // Delivery goes through the REAL status path (the one the Shiprocket
  // webhook and syncing use) — that's also the moment COD money exists.
  {
    panelOrders = await panelRead('orders');
    const target = panelOrders.find((o: any) => o.reference === orderRef);
    const deliveredRes = await fetch(`${base}/api/v1/admin/orders/${target.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${panelToken}` },
      body: JSON.stringify({ status: 'delivered' }),
    });
    check('the courier reports delivered', deliveredRes.status === 200, await deliveredRes.json());
  }
  const deliveredCod = await shop(`/me/orders/${orderRef}`, { token });
  check(
    'a delivered COD order is recorded as paid, invoice number minted',
    deliveredCod.body.order?.paymentStatus === 'paid' && Boolean(deliveredCod.body.order.invoiceNo),
    deliveredCod.body.order,
  );

  console.log('\nreturns + refund');

  /* ------------------------------------------------------ 5. the return */

  const form = new FormData();
  form.append('orderReference', orderRef);
  form.append('reason', 'Damaged in transit');
  form.append('description', 'Two of the sachets had split open inside the box.');
  const filed = await fetch(`${base}/api/v1/me/returns`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const filedBody = (await filed.json()) as any;
  check('the customer can file a return on a delivered order', filed.status === 201, filedBody);

  const secondAttempt = await fetch(`${base}/api/v1/me/returns`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: (() => {
      const f = new FormData();
      f.append('orderReference', orderRef);
      f.append('reason', 'Ordered by mistake');
      f.append('description', 'Trying to open a second return on the same order.');
      return f;
    })(),
  });
  check('only one return can be open per order', secondAttempt.status === 409, await secondAttempt.json());

  /* --- order help: chat answers + the call-back that lands in the inbox --- */

  const callback1 = await shop(`/me/orders/${orderRef}/callback`, { method: 'POST', token });
  check('“Request a call back” files a tagged query', callback1.status === 201 && callback1.body.already === false, callback1.body);
  const callback2 = await shop(`/me/orders/${orderRef}/callback`, { method: 'POST', token });
  check('asking twice re-confirms the same call back', callback2.status === 200 && callback2.body.already === true, callback2.body);
  const inboxQueries = await panelRead('queries');
  check(
    'the team sees the call back in the queries inbox, phone attached',
    inboxQueries.some((q: any) => q.topic === 'callback' && q.orderReference === orderRef && String(q.message).includes('call back')),
    inboxQueries.map((q: any) => q.topic),
  );

  /* ----------------------- the invoice, from the customer's own account --- */

  const invoiceRes = await fetch(`${base}/api/v1/me/orders/${orderRef}/invoice`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const invoiceHtml = await invoiceRes.text();
  check(
    'the customer can open the invoice — logo embedded, totals printed',
    invoiceRes.status === 200 && invoiceHtml.includes('data:image/png;base64') && invoiceHtml.includes('INVOICE'),
    invoiceRes.status,
  );

  /* -------- the parcel comes back: approve → receive puts it on the shelf --- */

  const shelfBefore = (await shop('/products/10x-daytime')).body.product.tiers[0].stock as number;
  const returnRows = await panelRead('returns');
  const activeReturn = returnRows.find((r: any) => r.orderReference === orderRef);
  const adminHeaders = { authorization: `Bearer ${panelToken}` };
  const approved = await fetch(`${base}/api/v1/admin/returns/${activeReturn.id}/approve`, {
    method: 'POST',
    headers: { ...adminHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ pickup: 'manual' }),
  });
  check('the team approves the return (manual pickup)', approved.status === 200, await approved.json());
  const received = await fetch(`${base}/api/v1/admin/returns/${activeReturn.id}/receive`, { method: 'POST', headers: adminHeaders });
  check('the parcel is received at the warehouse', received.status === 200, await received.json());
  const shelfAfter = (await shop('/products/10x-daytime')).body.product.tiers[0].stock as number;
  check('received items go back on the shelf — stock rises by the order quantity', shelfAfter > shelfBefore, { shelfBefore, shelfAfter });
  const receiveAgain = await fetch(`${base}/api/v1/admin/returns/${activeReturn.id}/receive`, { method: 'POST', headers: adminHeaders });
  const shelfSteady = (await shop('/products/10x-daytime')).body.product.tiers[0].stock as number;
  check('receiving twice cannot restock twice', receiveAgain.status === 400 && shelfSteady === shelfAfter, { shelfSteady });



  const panelReturns = await panelRead('returns');
  const panelReturn = panelReturns.find((r: any) => r.orderReference === orderRef);
  check(
    'the return reaches the panel with the money and method on it',
    panelReturn?.status === 'received' && panelReturn.amount === 2347 && panelReturn.paymentMethod === 'cod',
    panelReturn,
  );

  // The team pays the refund out — through the refund route, exactly as the
  // panel's button does. That is what writes the ledger entry on the order
  // and flips it to returned/refunded; the bridge never touches those.
  const refundRes = await fetch(`${base}/api/v1/admin/returns/${activeReturn.id}/refund`, { method: 'POST', headers: adminHeaders });
  check('the refund route accepts a received return', refundRes.status === 200, await refundRes.json().catch(() => ({})));
  const refundTwice = await fetch(`${base}/api/v1/admin/returns/${activeReturn.id}/refund`, { method: 'POST', headers: adminHeaders });
  check('a return cannot be refunded twice', refundTwice.status === 400);

  const customerReturns = await shop('/me/returns', { token });
  check(
    'the customer sees the refund on their own return',
    customerReturns.body.returns?.[0]?.status === 'refunded',
    customerReturns.body.returns,
  );

  const refundedForCustomer = await shop(`/me/orders/${orderRef}`, { token });
  check(
    'and the order says refunded on the account page',
    refundedForCustomer.body.order?.paymentStatus === 'refunded' &&
      refundedForCustomer.body.order.status === 'returned',
    refundedForCustomer.body.order,
  );

  const ledger = (await panelRead('orders')).find((o: any) => o.reference === orderRef);
  check(
    'the refund is on the order’s ledger, not just its status',
    ledger.payment.refunds?.[0]?.amount === 2347,
    ledger.payment,
  );

  console.log('\nsubscriptions');

  /* ------------------------------------------------ 6. the subscription */

  const subscribed = await shop('/checkout', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: product.id, tierId: tier.id, quantity: 1, subscribe: true }],
      address,
      paymentMethod: 'cod',
      couponCode: '',
    },
  });
  check(
    'subscribing charges the subscription price, not the one-time one',
    subscribed.body.order?.total === 1049 + 49,
    subscribed.body.order,
  );

  const mySubs = await shop('/me/subscriptions', { token });
  const sub = mySubs.body.subscriptions?.[0];
  check(
    'the plan appears with its cadence, pack and per-cycle saving',
    sub?.status === 'active' && sub.intervalDays === 28 && sub.savingsPerCycle === 150 && sub.packets.length > 0,
    sub,
  );

  const paused = await shop(`/me/subscriptions/${sub.reference}/action`, {
    method: 'POST',
    token,
    body: { action: 'pause' },
  });
  check('the customer can pause it', paused.body.subscription?.status === 'paused' && paused.body.subscription.nextDelivery === null, paused.body);

  const restarted = await shop(`/me/subscriptions/${sub.reference}/action`, {
    method: 'POST',
    token,
    body: { action: 'restart' },
  });
  check(
    'restarting ships within days rather than a full cycle later',
    restarted.body.subscription?.status === 'active' &&
      new Date(restarted.body.subscription.nextDelivery).getTime() - Date.now() < 4 * 86400_000,
    restarted.body.subscription,
  );

  const panelSubs = await panelRead('subscriptions');
  check(
    'the panel sees the plan, bound to a real pack',
    panelSubs[0]?.cadence === 'Every 4 weeks' && panelSubs[0].productId === product.id && panelSubs[0].tierId === tier.id,
    panelSubs[0],
  );

  console.log('\ncontact form');

  /* ------------------------------------------------------- 7. a query */

  const asked = await shop('/me/queries', {
    method: 'POST',
    token,
    body: {
      topic: 'order',
      message: 'When does the refund reach my account? It has been three days.',
    },
  });
  check('a signed-in customer can file a query — no name or phone typed', asked.status === 201 && /^Q-\d+$/.test(String(asked.body.reference)), asked.body);

  const anonAsk = await shop('/me/queries', {
    method: 'POST',
    body: { topic: 'other', message: 'Buy cheap watches at this definitely legitimate website.' },
  });
  const panelQueries = await panelRead('queries');
  check('signed-out visitors cannot file queries at all', anonAsk.status === 401, anonAsk.body);
  check(
    'the query carries the account name, email and phone by itself',
    panelQueries.some((q: any) => q.email === 'arjun@example.com' && q.name === 'Arjun Mehta' && typeof q.phone === 'string'),
    panelQueries.map((q: any) => q.email),
  );
  check(
    'the query lands in the panel inbox as new',
    panelQueries.some((q: any) => q.reference === asked.body.reference && q.status === 'new'),
    panelQueries[0],
  );

  // Answering is the one panel action that leaves the building, so it goes
  // through the authenticated API rather than the collection bridge.
  const inboxItem = panelQueries.find((q: any) => q.reference === asked.body.reference);
  const answered = await fetch(`${base}/api/v1/admin/queries/${inboxItem.id}/reply`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${panelToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ reply: 'Your refund lands 5–7 working days after the parcel reaches us.', close: true }),
  });
  const answeredBody = (await answered.json()) as any;
  check(
    'the primary admin can answer from the panel, and it is recorded against them',
    answered.status === 200 && answeredBody.query?.status === 'closed' && answeredBody.query?.answeredBy === env.adminName,
    answeredBody,
  );

  const inboxAfter = await panelRead('queries');
  check(
    'the answer shows on the query in the panel',
    inboxAfter.find((q: any) => q.reference === asked.body.reference)?.reply?.length > 0,
    inboxAfter[0],
  );

  console.log('\ncatalogue edits flow the other way');

  /* --------------------------------------- 8. the panel drives the shop */

  const panelProducts = await panelRead('products');
  panelProducts[0].tiers[0].oneTimePrice = 1299;
  panelProducts[0].storefront.ctaLabel = 'Take Charge';
  await panelWrite('products', panelProducts);

  const repriced = await shop('/products/10x-daytime');
  check(
    'a price change in the panel reaches the product page',
    repriced.body.product.tiers[0].oneTimePrice === 1299 && repriced.body.product.storefront.ctaLabel === 'Take Charge',
    repriced.body.product.tiers[0],
  );

  const atNewPrice = await shop('/checkout', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: product.id, tierId: tier.id, quantity: 1, subscribe: false }],
      address,
      paymentMethod: 'cod',
      couponCode: '',
    },
  });
  check(
    'and the checkout charges the new price',
    atNewPrice.body.order?.total === 1299 + 49,
    atNewPrice.body.order,
  );

  /* --------------------- delivery switch: free waives the fee everywhere */

  const goFree = await fetch(`${base}/api/v1/admin/settings/delivery`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${panelToken}` },
    body: JSON.stringify({ deliveryMode: 'free' }),
  });
  check('the panel can switch delivery to free', goFree.status === 200, await goFree.json());
  const freeSettings = await shop('/settings');
  check('the storefront is told delivery is free', freeSettings.body.settings?.deliveryMode === 'free');
  const freeOrder = await shop('/checkout', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: product.id, tierId: tier.id, quantity: 1, subscribe: false }],
      address,
      paymentMethod: 'cod',
      couponCode: '',
    },
  });
  check(
    'and the checkout charges no delivery fee below the threshold',
    freeOrder.status === 201 && freeOrder.body.order?.total === 1299,
    freeOrder.body.order,
  );
  const goPriced = await fetch(`${base}/api/v1/admin/settings/delivery`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${panelToken}` },
    body: JSON.stringify({ deliveryMode: 'priced', flatShipping: 49, freeShippingOver: 3000 }),
  });
  check('and can switch it back to priced', goPriced.status === 200);
  const pricedOrder = await shop('/checkout', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: product.id, tierId: tier.id, quantity: 1, subscribe: false }],
      address,
      paymentMethod: 'cod',
      couponCode: '',
    },
  });
  check(
    'priced mode charges the fee again',
    pricedOrder.status === 201 && pricedOrder.body.order?.total === 1299 + 49,
    pricedOrder.body.order,
  );

  const panelSettings = await panelRead('settings');
  panelSettings.store.codEnabled = false;
  await panelWrite('settings', panelSettings);

  const codBlocked = await shop('/checkout', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: product.id, tierId: tier.id, quantity: 1, subscribe: false }],
      address,
      paymentMethod: 'cod',
      couponCode: '',
    },
  });
  check(
    'switching cash on delivery off in the panel closes it at the checkout',
    codBlocked.status === 400 && /not available/.test(String(codBlocked.body.message)),
    codBlocked.body,
  );

  const publicSettings = await shop('/settings');
  check(
    'and the storefront is told, so it stops offering it',
    publicSettings.body.settings.codEnabled === false,
    publicSettings.body.settings,
  );

  /* ------------------------------------------------------------ wrap up */
  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  await disconnectDb();
  await mongod.stop();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
