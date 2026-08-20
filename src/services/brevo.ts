import { env } from '../config/env';

// Brevo transactional email (REST v3). Every send is fire-safe: a missing
// key or API failure logs and returns false — it never breaks an order flow.

const API = 'https://api.brevo.com/v3/smtp/email';

export async function sendEmail(opts: {
  to: { email: string; name?: string }[];
  subject: string;
  html: string;
  replyTo?: string;
}): Promise<boolean> {
  const apiKey = env.brevo.apiKey;
  const senderEmail = env.brevo.senderEmail;
  const senderName = env.brevo.senderName;
  if (!apiKey) {
    console.warn(`[brevo] no BREVO_API_KEY — skipped "${opts.subject}" to ${opts.to[0]?.email}`);
    return false;
  }
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: opts.to,
        subject: opts.subject,
        htmlContent: opts.html,
        replyTo: opts.replyTo ? { email: opts.replyTo } : undefined,
      }),
    });
    if (!res.ok) {
      console.error(`[brevo] ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[brevo] send failed:', err);
    return false;
  }
}
