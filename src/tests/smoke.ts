/* eslint-disable no-console */
// End-to-end smoke test against an in-memory MongoDB:
// health → seed roles/admin/product → admin login → RBAC deny → customer
// register → checkout (COD) → my orders → return filing guard → metrics.
// Run: npm run smoke

process.env.MONGODB_URI = 'mongodb://placeholder'; // replaced below
process.env.JWT_SECRET = 'smoke-test-secret';
process.env.ADMIN_JWT_SECRET = 'smoke-test-admin-secret';
process.env.ADMIN_NAME = 'Environment Owner';
process.env.ADMIN_EMAIL = 'founder@10xdrink.com';
process.env.ADMIN_PASSWORD = 'TakeCharge10x!';
process.env.AWS_S3_ACCESS_KEY_ID = '';
process.env.AWS_SES_ACCESS_KEY_ID = '';
process.env.AWS_SES_SECRET_ACCESS_KEY = '';
process.env.AWS_ACCESS_KEY_ID = '';
process.env.AWS_SECRET_ACCESS_KEY = '';
process.env.AWS_S3_SECRET_ACCESS_KEY = '';
process.env.AWS_S3_BUCKET = '';
process.env.BACKUP_S3_BUCKETS = '';
process.env.BACKUP_ENABLED = 'false';
process.env.NODE_ENV = 'test';

import { MongoMemoryServer } from 'mongodb-memory-server';

async function main() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();

  // Import AFTER env is set so config/env picks it up.
  const { connectDb, disconnectDb } = await import('../db/connect');
  const { createApp } = await import('../app');
  const { Product } = await import('../models/Product');
  const { AdminProfile } = await import('../models/AdminProfile');

  await connectDb(mongod.getUri());
  const app = createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, extra = '') => {
    if (ok) {
      passed++;
      console.log(`  PASS ${name}`);
    } else {
      failed++;
      console.error(`  FAIL ${name} ${extra}`);
    }
  };
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    // The customer session is an HttpOnly cookie (never echoed in JSON);
    // surface it so the test can act as that customer.
    const cookie = res.headers.get('set-cookie') ?? '';
    const session = cookie.match(/10x_customer_session=([^;]+)/)?.[1] ?? '';
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any, session: decodeURIComponent(session) };
  };
  const json = (body: unknown, token?: string): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  /* -------------------------------------------------------------- seed */
  const product = await Product.create({
    slug: '10x-daytime',
    name: '10X Daytime',
    status: 'active',
    tiers: [
      { name: '30 Pack', packets: 30, oneTimePrice: 1199, subscribePrice: 1049, stock: 10, lowStockAt: 5, available: true },
    ],
  });
  const tierId = product.tiers[0].id;

  // Simulate the stale identity written by an older deployment. The current
  // build must discard it and use only the backend environment identity.
  await AdminProfile.collection.insertOne({
    _id: 'primary',
    name: 'Old Database Admin',
    email: 'old-admin@example.com',
    avatarUrl: 'https://cdn.example.com/admin.webp',
    readNotificationIds: [],
    preferences: { fontScale: 100, density: 'comfortable', sidebarCollapsed: false, reduceMotion: false },
  } as any);

  /* ------------------------------------------------------------- tests */
  console.log('health + catalog');
  check('GET /health', (await api('/health')).body.ok === true);
  const products = await api('/api/v1/products');
  check('GET /products lists active', products.body.products?.length === 1);

  console.log('environment-only admin auth');
  const adminLogin = await api('/api/v1/admin/auth/login', json({ email: 'founder@10xdrink.com', password: 'TakeCharge10x!' }));
  check('admin login', adminLogin.status === 200 && Boolean(adminLogin.body.token));
  check(
    'primary identity comes from env while database-backed profile settings remain',
    adminLogin.body.user?.name === 'Environment Owner'
      && adminLogin.body.user?.email === 'founder@10xdrink.com'
      && adminLogin.body.user?.avatarUrl === 'https://cdn.example.com/admin.webp',
    JSON.stringify(adminLogin.body),
  );
  const adminToken = adminLogin.body.token as string;
  const storedPrimary = await AdminProfile.collection.findOne({ _id: 'primary' } as any);
  check(
    'legacy primary identity is removed from MongoDB',
    storedPrimary !== null && !('name' in storedPrimary) && !('email' in storedPrimary),
    JSON.stringify(storedPrimary),
  );
  const adminMe = await api('/api/v1/admin/auth/me', { headers: { authorization: `Bearer ${adminToken}` } });
  check('admin session resolves the env identity', adminMe.body.user?.name === 'Environment Owner' && adminMe.body.user?.email === 'founder@10xdrink.com');
  const primaryIdentityEdit = await api('/api/v1/admin/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: 'Database Override' }),
  });
  check('the panel cannot override the environment owner identity', primaryIdentityEdit.status === 400);

  const badLogin = await api('/api/v1/admin/auth/login', json({ email: 'founder@10xdrink.com', password: 'wrong' }));
  check('admin login rejects bad password', badLogin.status === 401);

  console.log('team roles + permissions');
  const roles = await api('/api/v1/admin/roles', { headers: { authorization: `Bearer ${adminToken}` } });
  check('default roles are available', roles.status === 200 && roles.body.roles?.some((role: any) => role.id === 'store-manager'));
  check('roles list hides Super Admin from every UI', roles.body.roles?.every((role: any) => role.id !== 'super-admin') === true);
  /* --------------------------------------- coming soon + early access */
  const signup = await api('/api/v1/signups', json({ email: 'earlybird@example.com' }));
  check('the coming-soon form stores a signup', signup.status === 201);
  await api('/api/v1/signups', json({ email: 'earlybird@example.com' }));
  const bot = await api('/api/v1/signups', json({ email: 'bot@example.com', company: 'filled' }));
  check('the signup honeypot swallows bots silently', bot.status === 201);
  const signupList = await api('/api/v1/admin/settings/signups', { headers: { authorization: `Bearer ${adminToken}` } });
  check(
    'signups reach the panel — deduplicated, no bots',
    signupList.body.total === 1 && signupList.body.signups?.[0]?.email === 'earlybird@example.com',
    JSON.stringify(signupList.body),
  );
  const comingOn = await api('/api/v1/admin/settings/coming-soon', { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ enabled: true }) });
  check('the owner can switch coming-soon mode on', comingOn.status === 200);
  const publicFlag = await api('/api/v1/settings');
  check('the storefront is told the shop is down', publicFlag.body.settings?.comingSoonMode === true);
  const comingOff = await api('/api/v1/admin/settings/coming-soon', { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ enabled: false }) });
  const publicFlagOff = await api('/api/v1/settings');
  check('and back on again', comingOff.status === 200 && publicFlagOff.body.settings?.comingSoonMode === false);

  /* ------------------------------------------------- face lock sign-in */
  const myFace = Array.from({ length: 128 }, (_, i) => Math.sin(i) * 0.4);
  const strangerFace = Array.from({ length: 128 }, (_, i) => Math.cos(i) * 0.4);
  const faceAnon = await api('/api/v1/admin/auth/face/enroll', json({ descriptors: [myFace] }));
  check('face enrolment requires a signed-in admin', faceAnon.status === 401);
  const faceEnroll = await api('/api/v1/admin/auth/face/enroll', json({ descriptors: [myFace] }, adminToken));
  check('an admin can enrol their face', faceEnroll.status === 201, JSON.stringify(faceEnroll.body));
  const faceStatus = await api('/api/v1/admin/auth/face', { headers: { authorization: `Bearer ${adminToken}` } });
  check('the face lock reports enrolled', faceStatus.body.enrolled === true && faceStatus.body.poses === 1);
  const faceLogin = await api('/api/v1/admin/auth/face/login', json({ email: 'founder@10xdrink.com', descriptor: myFace }));
  check('the enrolled face signs in', faceLogin.status === 200 && Boolean(faceLogin.body.token), JSON.stringify(faceLogin.body));
  const faceStranger = await api('/api/v1/admin/auth/face/login', json({ email: 'founder@10xdrink.com', descriptor: strangerFace }));
  check('a different face is refused', faceStranger.status === 401);
  const faceRemove = await api('/api/v1/admin/auth/face', { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } });
  check('the face lock can be removed', faceRemove.status === 200);
  const faceAfter = await api('/api/v1/admin/auth/face/login', json({ email: 'founder@10xdrink.com', descriptor: myFace }));
  check('a removed face lock no longer signs in', faceAfter.status === 401);

  const superAssign = await api('/api/v1/admin/team', json({
    name: 'Impostor',
    email: 'impostor@10x.test',
    roleId: 'super-admin',
  }, adminToken));
  check('Super Admin cannot be assigned, even by the owner', superAssign.status === 403, JSON.stringify(superAssign.body));
  const memberCreate = await api('/api/v1/admin/team', json({
    name: 'Store Operator',
    email: 'operator@10x.test',
    roleId: 'store-manager',
  }, adminToken));
  check('primary admin can add a team member', memberCreate.status === 201 && Boolean(memberCreate.body.member?.id), JSON.stringify(memberCreate.body));
  // With no mailer configured, the temp password comes back for one-time handover.
  const tempPassword = memberCreate.body.tempPassword as string;
  check('invite falls back to a one-time temp password when email is off', Boolean(tempPassword));
  const memberId = memberCreate.body.member?.id as string;
  const memberLogin = await api('/api/v1/admin/auth/login', json({ email: 'operator@10x.test', password: tempPassword }));
  check('team member can sign in with their database account', memberLogin.status === 200 && memberLogin.body.user?.role?.id === 'store-manager');
  const memberToken = memberLogin.body.token as string;
  const deniedRoles = await api('/api/v1/admin/roles', { headers: { authorization: `Bearer ${memberToken}` } });
  check('role permissions block team administration', deniedRoles.status === 403);
  const allowedProducts = await api('/api/v1/admin/products', { headers: { authorization: `Bearer ${memberToken}` } });
  check('role permissions allow assigned store work', allowedProducts.status === 200);
  const ownPassword = await api('/api/v1/admin/profile/password', json({ currentPassword: tempPassword, newPassword: 'MyOwnStrong#123' }, memberToken));
  check('a member can change their own password', ownPassword.status === 200, JSON.stringify(ownPassword.body));
  const relogin = await api('/api/v1/admin/auth/login', json({ email: 'operator@10x.test', password: 'MyOwnStrong#123' }));
  check('the new password signs in', relogin.status === 200);
  // Face lock is for EVERY panel account, not just the owner.
  const memberFace = Array.from({ length: 128 }, (_, i) => Math.sin(i * 2) * 0.35);
  const memberEnroll = await api('/api/v1/admin/auth/face/enroll', json({ descriptors: [memberFace] }, memberToken));
  check('a team member can enrol their own face', memberEnroll.status === 201, JSON.stringify(memberEnroll.body));
  const memberFaceLogin = await api('/api/v1/admin/auth/face/login', json({ email: 'operator@10x.test', descriptor: memberFace }));
  check('a team member signs in with their face', memberFaceLogin.status === 200 && Boolean(memberFaceLogin.body.token), JSON.stringify(memberFaceLogin.body));
  const crossFace = await api('/api/v1/admin/auth/face/login', json({ email: 'operator@10x.test', descriptor: myFace }));
  check('one admin’s face cannot open another’s account', crossFace.status === 401);

  const primaryPassword = await api('/api/v1/admin/profile/password', json({ currentPassword: 'TakeCharge10x!', newPassword: 'NotAllowed#12345' }, adminToken));
  check('the Super Admin password cannot change from the panel', primaryPassword.status === 400);
  const deactivate = await api(`/api/v1/admin/team/${memberId}/toggle`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}` } });
  check('primary admin can deactivate a team account', deactivate.status === 200);
  const inactiveSession = await api('/api/v1/admin/auth/me', { headers: { authorization: `Bearer ${memberToken}` } });
  check('deactivation invalidates existing sessions', inactiveSession.status === 401);
  const removeMember = await api(`/api/v1/admin/team/${memberId}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } });
  check('primary admin can delete a team account', removeMember.status === 200);


  console.log('customer flow');
  const reg = await api(
    '/api/v1/auth/register',
    json({ name: 'Asha Rao', email: 'asha@example.com', password: 'password123' }),
  );
  check('customer register', reg.status === 201 && Boolean(reg.session) && !reg.body.token);
  const customerToken = reg.session;

  const checkout = await api(
    '/api/v1/checkout',
    json(
      {
        items: [{ productId: product.id, tierId, quantity: 2 }],
        address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', phone: '9876543210' },
        paymentMethod: 'cod',
      },
      customerToken,
    ),
  );
  check('COD checkout creates order', checkout.status === 201 && Boolean(checkout.body.order?.reference), JSON.stringify(checkout.body));
  const reference = checkout.body.order?.reference as string;
  check('order is confirmed', checkout.body.order?.status === 'confirmed' || checkout.body.order?.status === 'placed');

  const overStock = await api(
    '/api/v1/checkout',
    json(
      {
        items: [{ productId: product.id, tierId, quantity: 10 }],
        address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', phone: '9876543210' },
        paymentMethod: 'cod',
      },
      customerToken,
    ),
  );
  check('checkout rejects over-stock quantity', overStock.status === 400, JSON.stringify(overStock.body));

  const myOrders = await api('/api/v1/me/orders', { headers: { authorization: `Bearer ${customerToken}` } });
  check('my orders lists the order', myOrders.body.orders?.[0]?.reference === reference);

  const noAuth = await api('/api/v1/me/orders');
  check('my orders requires auth', noAuth.status === 401);

  console.log('returns guard');
  const earlyReturn = await api('/api/v1/me/returns', {
    method: 'POST',
    headers: { authorization: `Bearer ${customerToken}` },
    body: (() => {
      const fd = new FormData();
      fd.append('orderReference', reference);
      fd.append('reason', 'Damaged');
      fd.append('description', 'The box arrived crushed and packets were torn.');
      return fd;
    })(),
  });
  check('return blocked before delivery', earlyReturn.status === 400, JSON.stringify(earlyReturn.body));

  console.log('admin ops');
  const orderList = await api('/api/v1/admin/orders?q=' + reference, { headers: { authorization: `Bearer ${adminToken}` } });
  check('admin order search finds it', orderList.body.orders?.length === 1);
  const orderId = orderList.body.orders?.[0]?._id as string;

  const statusChange = await api(`/api/v1/admin/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ status: 'delivered' }),
  });
  check('admin status → delivered', statusChange.body.order?.status === 'delivered');

  const metrics = await api('/api/v1/admin/metrics?range=30', { headers: { authorization: `Bearer ${adminToken}` } });
  check('metrics revenue counts the order', metrics.body.kpis?.revenue > 0, JSON.stringify(metrics.body.kpis ?? {}));

  const stockAfter = await Product.findById(product.id);
  check('stock decremented by 2', stockAfter?.tiers[0].stock === 8, `stock=${stockAfter?.tiers[0].stock}`);

  const events = await api('/api/v1/admin/events', { headers: { authorization: `Bearer ${adminToken}` } });
  check('events feed has entries', (events.body.events?.length ?? 0) >= 2);

  console.log('environment-only backend configuration');
  const removedConfigApi = await api('/api/v1/admin/config', { headers: { authorization: `Bearer ${adminToken}` } });
  check('backend key-management API is removed', removedConfigApi.status === 404);

  console.log('database backups');
  const backupRun = await api('/api/v1/admin/backups/run', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check(
    'backup without S3 fails gracefully',
    backupRun.status === 200 && backupRun.body.ok === false && /S3 is not configured/.test(String(backupRun.body.message)),
    JSON.stringify(backupRun.body),
  );
  const backupList = await api('/api/v1/admin/backups', { headers: { authorization: `Bearer ${adminToken}` } });
  check(
    'backup history records the failed run',
    backupList.body.records?.length === 1 && backupList.body.records[0].status === 'failed',
    JSON.stringify(backupList.body.records ?? []),
  );
  check('backup config summary present', backupList.body.config?.retentionDays === 30 && backupList.body.config?.enabled === false);
  const backupBridge = await api('/api/v1/admin/backups', { headers: { authorization: `Bearer ${adminToken}` } });
  check('backup status via panel session', backupBridge.status === 200);

  /* -------------------------------------------------- admin panel bridge */
  const BRIDGE = { authorization: `Bearer ${adminToken}` };
  const bridgeGet = async (name: string) =>
    api(`/api/v1/admin/collections/${name}`, { headers: BRIDGE });
  const bridgePut = async (name: string, data: unknown, knownIds?: string[]) =>
    api(`/api/v1/admin/collections/${name}`, {
      method: 'PUT',
      headers: { ...BRIDGE, 'content-type': 'application/json' },
      body: JSON.stringify({ data, ...(knownIds ? { knownIds } : {}) }),
    });
  /** What the panel does: read, then write back with the ids it saw. */
  const idsOf = (rows: any[]) => rows.map((r) => String(r.id));
  /** An id shaped like the panel's newId() — a real ObjectId. */
  const panelId = () =>
    Math.floor(Date.now() / 1000)
      .toString(16)
      .padStart(8, '0') +
    Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

  const bridgeOrders = await bridgeGet('orders');
  const panelOrder = bridgeOrders.body.data?.[0];
  check(
    'bridge serves orders in panel shape',
    bridgeOrders.status === 200 &&
      typeof panelOrder?.shipping === 'number' &&
      typeof panelOrder?.address?.house === 'string' &&
      panelOrder?.items?.[0]?.price > 0 &&
      panelOrder?.timeline?.length >= 6,
    JSON.stringify(panelOrder ?? bridgeOrders.body).slice(0, 300),
  );

  // Round trip: a panel edit must persist, and must not erase the fields the
  // panel never sees (the Cashfree linkage, the invoice number).
  const beforeEdit = await api(`/api/v1/admin/orders/${panelOrder.id}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const edited = bridgeOrders.body.data.map((o: any) =>
    o.id === panelOrder.id
      ? { ...o, status: 'packed', notes: [...(o.notes ?? []), { by: 'Panel', at: new Date().toISOString(), text: 'Packed by hand.' }] }
      : o,
  );
  const putOrders = await bridgePut('orders', edited);
  const afterEdit = await api(`/api/v1/admin/orders/${panelOrder.id}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  // Notes are the one thing the panel edits in place; status (and payment,
  // shipment, stock) belong to the lifecycle routes and must NOT move through
  // the bridge, or a stale panel tab could rewrite what the courier reported.
  check(
    'bridge writes a panel order note back, and leaves status to the lifecycle',
    putOrders.status === 200 &&
      afterEdit.body.order?.status === beforeEdit.body.order?.status &&
      afterEdit.body.order?.notes?.some((n: any) => n.text === 'Packed by hand.'),
    JSON.stringify(afterEdit.body.order ?? {}).slice(0, 300),
  );
  check(
    'a panel write preserves fields the panel never sees',
    afterEdit.body.order?.invoiceNo === beforeEdit.body.order?.invoiceNo &&
      afterEdit.body.order?.reference === beforeEdit.body.order?.reference &&
      afterEdit.body.order?.items?.[0]?.productId === beforeEdit.body.order?.items?.[0]?.productId,
    JSON.stringify({ before: beforeEdit.body.order?.invoiceNo, after: afterEdit.body.order?.invoiceNo }),
  );

  const bridgeCustomers = await bridgeGet('customers');
  check(
    'bridge serves customers with order stats',
    bridgeCustomers.body.data?.[0]?.ordersCount >= 1 &&
      bridgeCustomers.body.data?.[0]?.lastOrderAt !== null &&
      Array.isArray(bridgeCustomers.body.data?.[0]?.addresses),
    JSON.stringify(bridgeCustomers.body.data?.[0] ?? {}).slice(0, 250),
  );

  const bridgeProducts = await bridgeGet('products');
  const panelProduct = bridgeProducts.body.data?.[0];
  const panelTierId = panelProduct?.tiers?.[0]?.id;
  await bridgePut(
    'products',
    bridgeProducts.body.data.map((p: any) => ({
      ...p,
      tiers: p.tiers.map((t: any) => ({ ...t, oneTimePrice: 1249 })),
    })),
  );
  const productsAfter = await bridgeGet('products');
  check(
    'bridge round-trips a product price edit without re-keying tiers',
    productsAfter.body.data?.[0]?.tiers?.[0]?.oneTimePrice === 1249 &&
      productsAfter.body.data?.[0]?.tiers?.[0]?.id === panelTierId,
    JSON.stringify(productsAfter.body.data?.[0]?.tiers ?? []).slice(0, 200),
  );

  // Creates use the panel's own id, so "create then redirect to /x/<id>" lands.
  const newCouponId = panelId();
  const bridgeCoupons = await bridgeGet('coupons');
  await bridgePut('coupons', [
    ...bridgeCoupons.body.data,
    {
      id: newCouponId,
      code: 'PANEL15',
      description: '15% off, panel-created',
      type: 'percent',
      value: 15,
      minOrder: 500,
      maxDiscount: 200,
      usageLimit: null,
      usedCount: 0,
      perCustomerLimit: null,
      startsAt: new Date().toISOString(),
      expiresAt: null,
      active: true,
      createdBy: 'Founder',
    },
  ]);
  const couponsAfter = await bridgeGet('coupons');
  check(
    'a panel-created record keeps the id the panel minted',
    couponsAfter.body.data?.some((c: any) => c.id === newCouponId && c.code === 'PANEL15'),
    JSON.stringify(couponsAfter.body.data ?? []).slice(0, 200),
  );

  // The coupon the panel just created must work at the checkout.
  const couponCheck = await api('/api/v1/coupons/validate', json({ code: 'PANEL15', subtotal: 1000 }));
  check(
    'a panel-created coupon prices correctly on the storefront',
    couponCheck.status === 200 && couponCheck.body.discount === 150,
    JSON.stringify(couponCheck.body),
  );

  await bridgePut(
    'coupons',
    couponsAfter.body.data.filter((c: any) => c.id !== newCouponId),
    idsOf(couponsAfter.body.data),
  );
  const couponsPruned = await bridgeGet('coupons');
  check(
    'dropping a record from the panel array deletes it',
    !couponsPruned.body.data?.some((c: any) => c.id === newCouponId),
  );

  const bridgeSettings = await bridgeGet('settings');
  check(
    'bridge serves store settings without credential groups',
    bridgeSettings.body.data?.store?.flatShipping === 49 &&
      bridgeSettings.body.data?.cashfree === undefined &&
      bridgeSettings.body.data?.database === undefined &&
      typeof bridgeSettings.body.data?.warehouse?.pincode === 'string',
    JSON.stringify(bridgeSettings.body.data ?? {}).slice(0, 250),
  );
  await bridgePut('settings', {
    ...bridgeSettings.body.data,
    store: { ...bridgeSettings.body.data.store, flatShipping: 59, codEnabled: true },
  });
  const settingsAfter = await bridgeGet('settings');
  check(
    'a store setting edit reaches MongoDB without exposing keys',
    settingsAfter.body.data?.store?.flatShipping === 59 && settingsAfter.body.data?.cashfree === undefined,
    JSON.stringify(settingsAfter.body.data ?? {}),
  );

  const bridgeBlob = await bridgePut('secrets', [{ id: 'k1', provider: 'custom', label: 'Legacy key' }]);
  const blobBack = await bridgeGet('secrets');
  check(
    'legacy secret-vault collection is removed',
    bridgeBlob.status === 404 && blobBack.status === 404,
  );

  // Records the panel only reads are served from their real owner and are not
  // clobbered by a write-back.
  const autoBefore = await bridgeGet('syncing');
  await bridgePut('syncing', { lastRunAt: '2020-01-01T00:00:00.000Z', log: [{ at: '2020-01-01T00:00:00.000Z', text: 'nope' }] });
  const autoAfter = await bridgeGet('syncing');
  check(
    'read-only collections ignore a write from the panel',
    JSON.stringify(autoAfter.body.data) === JSON.stringify(autoBefore.body.data),
    JSON.stringify(autoAfter.body.data ?? {}),
  );

  // --- concurrency: two admins with the panel open at the same time.
  const roundA = await bridgeGet('orders');
  const roundB = await bridgeGet('orders');

  // B ships the order while A is still looking at the old copy.
  await bridgePut(
    'orders',
    roundB.body.data.map((o: any) =>
      o.id === panelOrder.id ? { ...o, notes: [...(o.notes ?? []), { by: 'B', at: new Date().toISOString(), text: 'Blue Dart' }] } : o,
    ),
    idsOf(roundB.body.data),
  );

  // A now saves an unrelated note from their stale copy.
  const staleWrite = await bridgePut(
    'orders',
    roundA.body.data.map((o: any) =>
      o.id === panelOrder.id
        ? { ...o, notes: [...(o.notes ?? []), { by: 'A', at: new Date().toISOString(), text: 'stale' }] }
        : o,
    ),
    idsOf(roundA.body.data),
  );
  check(
    'a stale panel write is refused instead of reverting a colleague’s edit',
    staleWrite.status === 409 && /changed by someone else/.test(String(staleWrite.body.message)),
    staleWrite.body,
  );
  const afterStale = await bridgeGet('orders');
  check(
    'the colleague’s edit survives',
    afterStale.body.data.find((o: any) => o.id === panelOrder.id)?.notes?.some((n: any) => n.text === 'Blue Dart') === true,
    JSON.stringify(afterStale.body.data.find((o: any) => o.id === panelOrder.id)?.notes ?? []),
  );

  // --- deletion scoping: a record created after someone's read must survive
  // their unrelated write.
  const beforeNew = await bridgeGet('coupons');
  const newestId = panelId();
  await bridgePut(
    'coupons',
    [
      ...beforeNew.body.data,
      { id: newestId, code: 'LATECOMER', description: 'Added after the other read', type: 'flat', value: 50, minOrder: 0, usageLimit: null, usedCount: 0, perCustomerLimit: null, startsAt: new Date().toISOString(), expiresAt: null, active: true, createdBy: 'B' },
    ],
    idsOf(beforeNew.body.data),
  );
  // Someone working from the earlier read saves an unrelated change.
  await bridgePut('coupons', beforeNew.body.data, idsOf(beforeNew.body.data));
  const afterUnrelated = await bridgeGet('coupons');
  check(
    'a record created by someone else is not deleted by an unrelated write',
    afterUnrelated.body.data.some((c: any) => c.id === newestId),
    afterUnrelated.body.data.map((c: any) => c.code),
  );

  const bridgeUnknown = await bridgeGet('nonsense');
  check('bridge rejects an unknown collection', bridgeUnknown.status === 404);
  const bridgeNoKey = await api('/api/v1/admin/collections/orders');
  check('bridge refuses a request with no admin session', bridgeNoKey.status === 401);

  /* ------------------------------------- payment creates the order, not checkout */
  {
    const { PendingCheckout } = await import('../models/PendingCheckout');
    const { materializePendingCheckout, markPendingCheckoutFailed } = await import('../services/orderLifecycle');
    const { Order: OrderModel } = await import('../models/Order');
    const { Product: ProductModel } = await import('../models/Product');

    const { Customer: CustomerModel } = await import('../models/Customer');
    const buyer = await CustomerModel.findOne({});
    const customerId = buyer!._id;
    const stockBefore = (await ProductModel.findById(product.id))!.tiers[0].stock;

    const draft = {
      customerId: customerId as never,
      customerName: 'Pending Payer',
      customerEmail: 'pending@example.com',
      items: [
        {
          productId: product.id as never,
          tierId,
          sku: 'SKU-1',
          name: '10X Daytime',
          tierName: '30 Pack',
          packets: '30',
          quantity: 1,
          unitPrice: 1199,
          subscribe: false,
        },
      ],
      subtotal: 1199,
      discount: 0,
      shippingFee: 0,
      total: 1199,
      address: { line1: '1 Test St', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', phone: '9999999999' },
      cashfree: { orderId: 'CF-PAID-1', paymentSessionId: 'sess' },
      expiresAt: new Date(Date.now() + 3600_000),
    };

    // An abandoned checkout must never become an order.
    const abandoned = await PendingCheckout.create({ ...draft, reference: 'TEST-ABANDON' });
    await markPendingCheckoutFailed(abandoned, 'abandoned');
    check(
      'an abandoned checkout creates no order',
      (await OrderModel.countDocuments({ reference: 'TEST-ABANDON' })) === 0 &&
        (await ProductModel.findById(product.id))!.tiers[0].stock === stockBefore,
      'stock must be untouched too',
    );

    // A paid one does — exactly once, however many callers race.
    const paidDraft = await PendingCheckout.create({ ...draft, reference: 'TEST-PAID' });
    const [first, second] = await Promise.all([
      materializePendingCheckout(paidDraft),
      materializePendingCheckout(await PendingCheckout.findById(paidDraft._id) as never),
    ]);
    const created = await OrderModel.find({ reference: 'TEST-PAID' });
    check(
      'a paid checkout creates exactly one order, even under a race',
      created.length === 1 && String(first?._id ?? '') === String(second?._id ?? ''),
      `${created.length} order(s)`,
    );
    check(
      'that order is paid, invoiced, and has taken stock',
      created[0]?.paymentStatus === 'paid' &&
        created[0]?.status === 'confirmed' &&
        Boolean(created[0]?.invoiceNo) &&
        (await ProductModel.findById(product.id))!.tiers[0].stock === stockBefore - 1,
      JSON.stringify({ pay: created[0]?.paymentStatus, status: created[0]?.status, invoice: created[0]?.invoiceNo }),
    );

    const settled = await PendingCheckout.findById(paidDraft._id);
    check('the checkout records which order it became', String(settled?.orderId ?? '') === String(created[0]?._id ?? ''));
  }

  /* ------------------------------------------- role cap: no second super admin */
  console.log('role cap + gatekeeping');
  const { ALL_PERMISSION_IDS } = await import('../auth/permissions');

  const starRole = await api('/api/v1/admin/roles', json({
    name: 'Sneaky Wildcard', description: '', permissions: ['*'],
  }, adminToken));
  check(
    'a custom role cannot use the all-access wildcard',
    starRole.status === 400 && /Super Admin/i.test(String(starRole.body.message)),
    JSON.stringify(starRole.body),
  );

  const everyBox = await api('/api/v1/admin/roles', json({
    name: 'Everything Ticked', description: '', permissions: [...ALL_PERMISSION_IDS],
  }, adminToken));
  check(
    'a custom role cannot tick every permission',
    everyBox.status === 400 && /second Super Admin|every permission/i.test(String(everyBox.body.message)),
    JSON.stringify(everyBox.body),
  );

  const almostAll = await api('/api/v1/admin/roles', json({
    name: 'Almost Everything', description: '', permissions: ALL_PERMISSION_IDS.slice(0, -1),
  }, adminToken));
  check('one permission short of everything is allowed', almostAll.status === 201, JSON.stringify(almostAll.body));
  const almostAllId = almostAll.body.role?.id as string;

  const sneakyPatch = await api(`/api/v1/admin/roles/${almostAllId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ permissions: [...ALL_PERMISSION_IDS] }),
  });
  check('editing a role up to every permission is refused too', sneakyPatch.status === 400, JSON.stringify(sneakyPatch.body));
  await api(`/api/v1/admin/roles/${almostAllId}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } });

  const superEdit = await api('/api/v1/admin/roles/super-admin', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: 'Renamed' }),
  });
  check('the built-in Super Admin role cannot be edited at all', superEdit.status === 403);

  /* --------------------------------------- module-by-module gate re-check */
  // The earlier store-manager member was deleted; make a fresh one so these
  // gates are exercised with a live, active session.
  const gateMember = await api('/api/v1/admin/team', json({
    name: 'Gate Tester',
    email: 'gates@10x.test',
    roleId: 'store-manager',
  }, adminToken));
  check('gate-test member created', gateMember.status === 201, JSON.stringify(gateMember.body));
  const gateLogin = await api('/api/v1/admin/auth/login', json({ email: 'gates@10x.test', password: gateMember.body.tempPassword }));
  const gateToken = gateLogin.body.token as string;

  // Allowed store work, denied admin administration — across every module
  // boundary, not just one.
  const gates: [string, string, RequestInit | undefined, number][] = [
    ['orders list allowed', '/api/v1/admin/orders', { headers: { authorization: `Bearer ${gateToken}` } }, 200],
    ['metrics allowed', '/api/v1/admin/metrics?range=7', { headers: { authorization: `Bearer ${gateToken}` } }, 200],
    ['returns list allowed', '/api/v1/admin/returns', { headers: { authorization: `Bearer ${gateToken}` } }, 200],
    ['queries list allowed', '/api/v1/admin/queries', { headers: { authorization: `Bearer ${gateToken}` } }, 200],
    ['delivery charges edit denied', '/api/v1/admin/settings/delivery', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${gateToken}` },
      body: JSON.stringify({ deliveryMode: 'free' }),
    }, 403],
    ['team administration denied', '/api/v1/admin/team', { headers: { authorization: `Bearer ${gateToken}` } }, 403],
    ['role creation denied', '/api/v1/admin/roles', json({ name: 'X2', description: '', permissions: ['orders.view'] }, gateToken), 403],
    ['backups denied', '/api/v1/admin/backups', { headers: { authorization: `Bearer ${gateToken}` } }, 403],
    // The bridge follows the role now: reads a member's role covers work,
    // while store-wide surfaces stay with the owner.
    ['panel data allowed where the role covers it', '/api/v1/admin/collections/orders', { headers: { authorization: `Bearer ${gateToken}` } }, 200],
    ['store-wide settings writes stay Super Admin', '/api/v1/admin/collections/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${gateToken}` },
      body: JSON.stringify({ data: {} }),
    }, 403],
  ];
  for (const [name, path, init, expected] of gates) {
    const out = await api(path, init);
    check(name, out.status === expected, `got ${out.status}, wanted ${expected}`);
  }

  // A member whose role is deleted out from under them loses access cleanly.
  const grantable = await api('/api/v1/admin/roles', json({
    name: 'Temp Viewer', description: '', permissions: ['dashboard.view'],
  }, gateToken));
  check('a member cannot create roles at all without roles.create', grantable.status === 403);

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
