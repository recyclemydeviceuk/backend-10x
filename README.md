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

## Integrations

- Cashfree handles online checkout and refunds.
- Shiprocket handles fulfilment, tracking, and reverse pickup.
- AWS SES sends transactional email; the old Brevo adapter remains disconnected for a future switch.
- AWS S3 stores media and daily gzipped EJSON MongoDB backups.
- Backend syncing runs on `SYNC_INTERVAL_SECONDS`; an external scheduler can call `POST /api/v1/internal/sync/run` with `x-sync-key`.
- Daily backups run at `BACKUP_HOUR_IST` and can also be started from Admin → Settings → Backups.

Customer authentication uses an HttpOnly API cookie. The admin panel stores its backend-issued JWT in its own HttpOnly cookie and calls all admin APIs with that token.
