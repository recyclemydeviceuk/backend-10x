import dotenv from 'dotenv';

dotenv.config();

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} — see .env.example`);
  return value;
};

const optional = (name: string, fallback = ''): string => process.env[name] ?? fallback;

const nodeEnv = optional('NODE_ENV', 'development');
// Render exposes RENDER=true to every hosted service. Treat it as production
// even when NODE_ENV was not added manually in the dashboard; otherwise
// Express emits insecure Lax cookies that a separate storefront origin cannot
// use for login, cart, or checkout.
const isProd = nodeEnv === 'production' || optional('RENDER') === 'true';

export const env = {
  nodeEnv,
  isProd,
  port: Number(optional('PORT', '4000')),

  mongoUri: required('MONGODB_URI'),
  mongoDb: optional('MONGODB_DB', '10x'),

  jwtSecret: required('JWT_SECRET'),
  adminJwtSecret: optional('ADMIN_JWT_SECRET') || required('JWT_SECRET'),
  adminEmail: required('ADMIN_EMAIL').trim().toLowerCase(),
  adminPassword: required('ADMIN_PASSWORD'),
  adminName: required('ADMIN_NAME').trim(),

  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:3000,http://localhost:3010')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  storefrontUrl: optional('STOREFRONT_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  adminUrl: optional('ADMIN_URL', 'http://localhost:3010').replace(/\/+$/, ''),
  // The address this API is reachable at from the internet. Render sets
  // RENDER_EXTERNAL_URL automatically; set API_PUBLIC_URL to override it
  // (a custom domain, or another host). Used to build the webhook URL that
  // is attached to every Cashfree order and printed at startup.
  publicApiUrl: (optional('API_PUBLIC_URL') || optional('RENDER_EXTERNAL_URL')).replace(/\/+$/, ''),

  s3: {
    region: optional('AWS_S3_REGION', optional('AWS_REGION', 'ap-south-1')),
    accessKeyId: optional('AWS_S3_ACCESS_KEY_ID', optional('AWS_ACCESS_KEY_ID')),
    secretAccessKey: optional('AWS_S3_SECRET_ACCESS_KEY', optional('AWS_SECRET_ACCESS_KEY')),
    bucket: optional('AWS_S3_BUCKET', optional('S3_BUCKET')),
    publicBaseUrl: optional('AWS_S3_PUBLIC_BASE_URL', optional('S3_PUBLIC_BASE_URL')),
  },

  ses: {
    region: optional('AWS_SES_REGION', optional('AWS_REGION', 'ap-south-1')),
    accessKeyId: optional('AWS_SES_ACCESS_KEY_ID', optional('AWS_ACCESS_KEY_ID')),
    secretAccessKey: optional('AWS_SES_SECRET_ACCESS_KEY', optional('AWS_SECRET_ACCESS_KEY')),
    fromEmail: optional('FROM_EMAIL', 'mailer@zennara.in'),
    fromName: optional('FROM_NAME', '10X'),
  },

  brevo: {
    apiKey: optional('BREVO_API_KEY'),
    senderEmail: optional('BREVO_SENDER_EMAIL', 'orders@10xdrink.com'),
    senderName: optional('BREVO_SENDER_NAME', '10X'),
  },

  cashfree: {
    env: optional('CASHFREE_ENV', 'sandbox') === 'production' ? 'production' : 'sandbox',
    appId: optional('CASHFREE_APP_ID'),
    secretKey: optional('CASHFREE_SECRET_KEY'),
  },

  shiprocket: {
    email: optional('SHIPROCKET_EMAIL'),
    password: optional('SHIPROCKET_PASSWORD'),
    pickupLocation: optional('SHIPROCKET_PICKUP_LOCATION', 'Primary'),
    packageWeightKg: Number(optional('SHIPROCKET_PACKAGE_WEIGHT_KG', optional('SHIPROCKET_PACKAGE_WEIGHT', '0.5'))),
  },

  backup: {
    enabled: optional('BACKUP_ENABLED', 'true') === 'true',
    buckets: optional('BACKUP_S3_BUCKETS'),
    hourIst: Number(optional('BACKUP_HOUR_IST', '3')),
    retentionDays: Number(optional('BACKUP_RETENTION_DAYS', '30')),
  },

  syncKey: optional('SYNC_KEY'),
  syncIntervalSeconds: Number(optional('SYNC_INTERVAL_SECONDS', '60')),
} as const;

export const CASHFREE_WEBHOOK_PATH = '/api/v1/webhooks/cashfree';
export const SHIPROCKET_WEBHOOK_PATH = '/api/v1/webhooks/shiprocket';

const isHttps = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Things that silently break payments in production but are not fatal at
 * startup. Printed once when the server boots so a misconfigured deploy is
 * visible in the Render logs instead of in a customer's checkout.
 */
export function productionConfigWarnings(): string[] {
  const warnings: string[] = [];
  if (!env.isProd) return warnings;

  if (env.cashfree.env !== 'production') {
    warnings.push('CASHFREE_ENV is not "production" — real customers would be sent to the Cashfree sandbox.');
  }
  if (!env.cashfree.appId || !env.cashfree.secretKey) {
    warnings.push('CASHFREE_APP_ID / CASHFREE_SECRET_KEY are empty — online payment is disabled, COD only.');
  }
  if (!isHttps(env.storefrontUrl)) {
    warnings.push(
      `STOREFRONT_URL (${env.storefrontUrl}) is not https — Cashfree rejects a non-https return_url, so customers who leave the modal (UPI intent) cannot be brought back to the confirmation page.`,
    );
  }
  if (!env.publicApiUrl) {
    warnings.push('API_PUBLIC_URL is empty (and RENDER_EXTERNAL_URL not present) — notify_url is not attached to Cashfree orders; webhooks rely on the dashboard setting alone.');
  } else if (!isHttps(env.publicApiUrl)) {
    warnings.push(`API_PUBLIC_URL (${env.publicApiUrl}) is not https — Cashfree only delivers webhooks to https endpoints.`);
  }
  if (env.corsOrigins.some((o) => /localhost|127\.0\.0\.1/.test(o))) {
    warnings.push('CORS_ORIGINS still lists a localhost origin — remove it in production.');
  }
  if (!env.corsOrigins.includes(env.storefrontUrl)) {
    warnings.push(`CORS_ORIGINS does not include STOREFRONT_URL (${env.storefrontUrl}) — the storefront cannot call this API from the browser.`);
  }
  if (env.jwtSecret.length < 32) {
    warnings.push('JWT_SECRET is shorter than 32 characters — use a long random value in production.');
  }
  if (process.env.ALLOW_TEST_PAYMENTS === 'true') {
    warnings.push('ALLOW_TEST_PAYMENTS is set — it is ignored in production, but remove it to avoid confusion.');
  }
  return warnings;
}
