import { Resend } from 'resend';
import { logger } from '@/lib/logger';

/** Receipt + delivery email for marketplace purchases. No-op without RESEND_API_KEY. */

function getFromAddress(): string {
  const raw = process.env.RESEND_FROM_EMAIL ?? 'notifications@alerts.usecola.com';
  if (raw.includes('@')) return raw;
  return `notifications@${raw}`;
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

export async function sendOrderRefundedEmail(params: {
  to: string;
  productName: string;
  amountCents: number;
  orderId: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from: getFromAddress(),
      to: params.to,
      subject: `Your ${params.productName} purchase was refunded`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111827;line-height:1.6">
        <p>Your purchase of <strong>${esc(params.productName)}</strong> (${dollars(params.amountCents)}) has been refunded.
        The associated license has been deactivated.</p>
        <p style="color:#6b7280;font-size:12px">Order ${esc(params.orderId)} · Cola marketplace.</p>
      </div>`,
    });
  } catch (err) {
    logger.warn('[marketplace] refund email failed', { orderId: params.orderId, err: String(err) });
  }
}

export async function sendOrderReceiptEmail(params: {
  to: string;
  productName: string;
  sellerName: string;
  amountCents: number;
  licenseKey: string;
  orderId: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const base = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  const portalUrl = `${base}/buyer`;

  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from: getFromAddress(),
      to: params.to,
      subject: `Your ${params.productName} purchase — license inside`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111827;line-height:1.6">
        <p>Thanks for your purchase.</p>
        <table style="border-collapse:collapse;margin:12px 0">
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Product</td><td>${esc(params.productName)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Seller</td><td>${esc(params.sellerName)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Amount</td><td>${dollars(params.amountCents)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Order</td><td>${esc(params.orderId)}</td></tr>
        </table>
        <p>Your license key:</p>
        <p style="font-family:ui-monospace,monospace;font-size:15px;background:#f3f4f6;padding:10px 14px;border-radius:8px;display:inline-block">${esc(params.licenseKey)}</p>
        <p><a href="${portalUrl}" style="color:#111827;font-weight:600">Track your purchases in the buyer portal →</a></p>
        <p style="color:#6b7280;font-size:12px">Sold through the Cola marketplace.</p>
      </div>`,
    });
  } catch (err) {
    logger.warn('[marketplace] receipt email failed', { orderId: params.orderId, err: String(err) });
  }
}
