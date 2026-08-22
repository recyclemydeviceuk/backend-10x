# 10X backend

Express + TypeScript + MongoDB Atlas backend shared by the storefront and admin panel.

## Data and secrets

- MongoDB is the only business-data store: catalogue, customers, carts, orders, subscriptions, returns, settings, analytics events, admin profile/preferences, and backup history.
- All credentials and infrastructure configuration live only in `server/.env`: MongoDB, admin sign-in, JWT secrets, Cashfree, Shiprocket, S3, SES, backup schedule, and sync key.
- There is no admin endpoint or UI for listing, revealing, saving, or deleting infrastructure keys.
- The primary admin identity and sign-in are checked against `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`. MongoDB holds only that account's photo, notification state, and panel preferences.

## Run

```bash
cp .env.example .env
npm install
npm run seed
npm run dev
```

The API defaults to `http://localhost:4000`. Use `npm run typecheck`, `npm run smoke`, and `npm run journey` to verify it.

## Production (Render)

Live API: `https://backend-10x.onrender.com`. Render env vars that matter for payments:

| Variable | Production value |
| --- | --- |
| `NODE_ENV` | `production` (Render's `RENDER=true` also forces production mode) |
| `CASHFREE_ENV` | `production` |
| `CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY` | the **production** key pair from merchant.cashfree.com → Developers → API Keys |
| `STOREFRONT_URL` | the live storefront, `https://…` (Cashfree rejects an http return_url) |
| `CORS_ORIGINS` | the live storefront + admin origins, comma-separated, no localhost |
| `API_PUBLIC_URL` | optional — Render's `RENDER_EXTERNAL_URL` is used when unset |
| `JWT_SECRET` / `ADMIN_JWT_SECRET` | long random strings (32+ chars) |
| `ALLOW_TEST_PAYMENTS` | **not set** |

The server prints `CONFIG WARNING:` lines at boot for anything above that is off.

### Cashfree dashboard

1. **Webhook** — Developers → Webhooks → Payment Gateway → Add endpoint:
   `POST https://backend-10x.onrender.com/api/v1/webhooks/cashfree`, API version `2023-08-01`, events
   `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `PAYMENT_USER_DROPPED_WEBHOOK`, `REFUND_STATUS_WEBHOOK`.
   Every order also carries this URL as `notify_url`, so payments are confirmed even if the dashboard entry is missing.
2. **Subscriptions webhook** (auto-pay) — Developers → Webhooks → Subscriptions → the **same URL**, events
   `SUBSCRIPTION_STATUS_CHANGED`, `SUBSCRIPTION_PAYMENT_SUCCESS_WEBHOOK`, `SUBSCRIPTION_PAYMENT_FAILED_WEBHOOK`.
3. **Whitelisting** — Developers → Whitelisting: add the storefront domain (and `https://10xdrink.com` / `www`).
   The live JS SDK refuses to open on any origin that is not listed ("Broken Link!").
4. **Return URL** — nothing to set; the API sends `STOREFRONT_URL/checkout/success?ref=…` per order.
5. Signature = `base64(HMAC-SHA256(timestamp + rawBody, CASHFREE_SECRET_KEY))` from headers
   `x-webhook-signature` / `x-webhook-timestamp`; a mismatch returns 401 and the event is ignored.

The webhook route is mounted before the JSON parser and the rate limiter, so retries from Cashfree are never throttled.
`GET` on the webhook URL returns a small JSON message for sanity checks.

### Shiprocket

Settings → API → Webhooks: `POST https://backend-10x.onrender.com/api/v1/webhooks/shiprocket`.

### Render notes

- Free/hobby instances sleep after idle; the first webhook after a sleep can take ~30–60 s. Cashfree retries, and the
  confirmation page re-checks the order itself, but a paid instance (or an uptime ping on `/health`) avoids the delay.
- Admin panel → Settings → Syncing → **autoShipments** books real Shiprocket shipments for every paid order. Keep it
  off until you are ready to ship.

## Integrations

- Cashfree handles online checkout and refunds.
- Shiprocket handles fulfilment, tracking, and reverse pickup.
- AWS SES sends transactional email; the old Brevo adapter remains disconnected for a future switch.
- AWS S3 stores media and daily gzipped EJSON MongoDB backups.
- Backend syncing runs on `SYNC_INTERVAL_SECONDS`; an external scheduler can call `POST /api/v1/internal/sync/run` with `x-sync-key`.
- Daily backups run at `BACKUP_HOUR_IST` and can also be started from Admin → Settings → Backups.

Customer authentication uses an HttpOnly API cookie. The admin panel stores its backend-issued JWT in its own HttpOnly cookie and calls all admin APIs with that token.
