import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import path from 'path';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';

// Media rules — identical to the admin panel's lib/media-specs.ts.
export const IMAGE_SPEC = {
  types: ['image/jpeg', 'image/png', 'image/webp'],
  typeLabel: 'JPG, PNG or WebP',
  maxBytes: 5 * 1024 * 1024,
  sizeLabel: '5 MB',
} as const;

export const VIDEO_SPEC = {
  types: ['video/mp4', 'video/webm'],
  typeLabel: 'MP4 or WebM',
  maxBytes: 50 * 1024 * 1024,
  sizeLabel: '50 MB',
} as const;

type AwsConfig = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
};

const awsConfig = (): AwsConfig => env.s3;

// Client is rebuilt whenever the panel-managed credentials change.
let client: { instance: S3Client; snapshot: string } | null = null;

async function s3(): Promise<{ instance: S3Client; cfg: AwsConfig }> {
  const cfg = awsConfig();
  if (!cfg.bucket) {
    throw ApiError.badRequest('S3 is not configured on the backend.');
  }
  const snapshot = `${cfg.region}|${cfg.accessKeyId}|${cfg.secretAccessKey}|${cfg.bucket}`;
  if (!client || client.snapshot !== snapshot) {
    client = {
      snapshot,
      instance: new S3Client({
        region: cfg.region,
        credentials: cfg.accessKeyId
          ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
          : undefined,
      }),
    };
  }
  return { instance: client.instance, cfg };
}

function publicUrl(cfg: AwsConfig, key: string): string {
  if (cfg.publicBaseUrl) return `${cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  return `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${key}`;
}

const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;

/** Validates against the media spec, then stores under `<folder>/…`. Returns the public URL. */
export async function uploadMedia(
  file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  folder: 'products' | 'returns' | 'profiles',
): Promise<string> {
  const isImage = (IMAGE_SPEC.types as readonly string[]).includes(file.mimetype);
  const isVideo = (VIDEO_SPEC.types as readonly string[]).includes(file.mimetype);
  if (!isImage && !isVideo) {
    throw ApiError.badRequest(
      `Unsupported type ${file.mimetype || 'unknown'}. Images: ${IMAGE_SPEC.typeLabel}. Videos: ${VIDEO_SPEC.typeLabel}.`,
    );
  }
  const spec = isImage ? IMAGE_SPEC : VIDEO_SPEC;
  if (file.size > spec.maxBytes) {
    throw ApiError.badRequest(
      `${fmtBytes(file.size)} is over the ${spec.sizeLabel} ${isImage ? 'image' : 'video'} limit.`,
    );
  }

  const ext = path.extname(file.originalname).toLowerCase() || (isVideo ? '.mp4' : '.png');
  const base =
    path
      .basename(file.originalname, path.extname(file.originalname))
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'upload';
  const key = `${folder}/${base}-${crypto.randomBytes(4).toString('hex')}${ext}`;

  const { instance, cfg } = await s3();
  await instance.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );

  return publicUrl(cfg, key);
}

export async function isS3Configured(): Promise<boolean> {
  const cfg = awsConfig();
  return Boolean(cfg.bucket && cfg.accessKeyId);
}

/** Raw put into an arbitrary bucket (backups use their own buckets). */
export async function putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
  const { instance } = await s3();
  await instance.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function listKeys(bucket: string, prefix: string): Promise<{ key: string; lastModified?: Date }[]> {
  const { instance } = await s3();
  const out: { key: string; lastModified?: Date }[] = [];
  let token: string | undefined;
  do {
    const page = await instance.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const item of page.Contents ?? []) {
      if (item.Key) out.push({ key: item.Key, lastModified: item.LastModified });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  const { instance } = await s3();
  await instance.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Best-effort delete of an object previously stored by uploadMedia. */
export async function deleteMedia(url: string): Promise<void> {
  try {
    const { instance, cfg } = await s3();
    const key = url.split('.amazonaws.com/')[1] ?? (cfg.publicBaseUrl ? url.split(`${cfg.publicBaseUrl}/`)[1] : undefined);
    if (!key) return;
    await instance.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  } catch (err) {
    console.error('[s3] delete failed:', err);
  }
}
