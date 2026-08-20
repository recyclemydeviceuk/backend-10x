import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { env } from '../config/env';

let client: SESv2Client | null = null;

function ses(): SESv2Client | null {
  const cfg = env.ses;
  if (!cfg.accessKeyId || !cfg.secretAccessKey || !cfg.fromEmail) return null;
  if (!client) {
    client = new SESv2Client({
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  return client;
}

/** Transactional email through AWS SES. Failures never interrupt an order flow. */
export async function sendEmail(opts: {
  to: { email: string; name?: string }[];
  subject: string;
  html: string;
  /** Plain-text counterpart for accessibility and clients that block HTML. */
  text?: string;
  replyTo?: string;
}): Promise<boolean> {
  const instance = ses();
  if (!instance) {
    console.warn(`[ses] credentials are not configured — skipped "${opts.subject}"`);
    return false;
  }
  try {
    await instance.send(
      new SendEmailCommand({
        FromEmailAddress: `${env.ses.fromName} <${env.ses.fromEmail}>`,
        Destination: { ToAddresses: opts.to.map((recipient) => recipient.email) },
        ReplyToAddresses: opts.replyTo ? [opts.replyTo] : undefined,
        Content: {
          Simple: {
            Subject: { Data: opts.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: opts.html, Charset: 'UTF-8' },
              ...(opts.text ? { Text: { Data: opts.text, Charset: 'UTF-8' } } : {}),
            },
          },
        },
      }),
    );
    return true;
  } catch (error) {
    console.error('[ses] send failed:', error instanceof Error ? error.message : error);
    return false;
  }
}
