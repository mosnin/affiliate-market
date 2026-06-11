import { Resend } from 'resend';
import { logger } from '@/lib/logger';

/**
 * Affiliate lifecycle emails. Same conventions as lib/email.ts: silently
 * no-op when RESEND_API_KEY is missing so local/dev never blocks on email.
 */

function getFromAddress(): string {
  const raw = process.env.RESEND_FROM_EMAIL ?? 'notifications@alerts.usecola.com';
  if (raw.includes('@')) return raw;
  return `notifications@${raw}`;
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
}

function esc(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function dollars(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    cents / 100,
  );
}

async function send(to: string, subject: string, html: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({ from: getFromAddress(), to, subject, html });
  } catch (err) {
    logger.warn('[affiliates] email send failed', { subject, err: String(err) });
  }
}

export async function sendPartnerApprovedEmail(params: {
  to: string;
  partnerName: string;
}): Promise<void> {
  const dashboard = `${appUrl()}/affiliate/dashboard`;
  await send(
    params.to,
    "You're in — your Cola affiliate account is approved",
    `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111827;line-height:1.6">
      <p>Hi ${esc(params.partnerName)},</p>
      <p>Your affiliate application was approved. Your referral link is ready — share it and earn a commission on every sale it brings in.</p>
      <p><a href="${dashboard}" style="color:#111827;font-weight:600">Open your affiliate dashboard →</a></p>
      <p style="color:#6b7280;font-size:12px">Cola — the agentic sales OS for software companies.</p>
    </div>`,
  );
}

export async function sendCommissionEarnedEmail(params: {
  to: string;
  partnerName: string;
  amountCents: number;
  pendingApproval: boolean;
}): Promise<void> {
  const dashboard = `${appUrl()}/affiliate/dashboard`;
  const statusLine = params.pendingApproval
    ? 'It will appear in your balance once the seller approves it.'
    : 'It has been approved and added to your payable balance.';
  await send(
    params.to,
    `You earned ${dollars(params.amountCents)} in commission`,
    `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111827;line-height:1.6">
      <p>Hi ${esc(params.partnerName)},</p>
      <p>A purchase just came through your referral link — you earned <strong>${dollars(params.amountCents)}</strong>. ${statusLine}</p>
      <p><a href="${dashboard}" style="color:#111827;font-weight:600">See your earnings →</a></p>
      <p style="color:#6b7280;font-size:12px">Cola — the agentic sales OS for software companies.</p>
    </div>`,
  );
}
