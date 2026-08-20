import dotenv from 'dotenv';

dotenv.config();

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} — see .env.example`);
  return value;
};

const optional = (name: string, fallback = ''): string => process.env[name] ?? fallback;

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  isProd: optional('NODE_ENV') === 'production',
  port: Number(optional('PORT', '4000')),

  mongoUri: required('MONGODB_URI'),
  mongoDb: optional('MONGODB_DB', '10x'),

  jwtSecret: required('JWT_SECRET'),
  adminJwtSecret: optional('ADMIN_JWT_SECRET') || required('JWT_SECRET'),
  adminEmail: required('ADMIN_EMAIL').trim().toLowerCase(),
  adminPassword: required('ADMIN_PASSWORD'),
  adminName: optional('ADMIN_NAME', 'Khushnood').trim() || 'Khushnood',

  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:3000,http://localhost:3010')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  storefrontUrl: optional('STOREFRONT_URL', 'http://localhost:3000'),
  adminUrl: optional('ADMIN_URL', 'http://localhost:3010'),

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
