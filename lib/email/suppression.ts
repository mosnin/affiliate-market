import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

/**
 * Email opt-out: signed unsubscribe tokens + a suppression check.
 *
 * The unsubscribe link in a marketing email has to work with no login, can't be
 * forgeable (a competitor must not be able to unsubscribe your creators by
 * guessing emails), and shouldn't require us to persist a token per send. So the
 * token is stateless and self-authenticating: `base64url(payload).hmac` where
 * payload is `${listType}:${email}` and the HMAC is keyed by the app secret.
 * Verifying recomputes the HMAC and timing-safe-compares it. On a valid hit we
 * write one EmailSuppression row; every digest send checks isEmailSuppressed()
 * first.
 *
 * Only the two recurring marketing emails (creator/seller weekly digests) use
 * this. Transactional mail is exempt and never calls it.
 */

export type EmailListType = 'creator_digest' | 'seller_digest';
const LIST_TYPES: readonly EmailListType[] = ['creator_digest', 'seller_digest'];

/**
 * HMAC key derived from the app secret — same precedence as lib/crypto.ts so we
 * don't introduce a new required env var. The message is namespaced ("unsub:")
 * so these tokens can never be confused with any other HMAC in the system.
 */
function signingKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY || process.env.CLERK_SECRET_KEY;
  if (!secret) {
    throw new Error('ENCRYPTION_KEY (or CLERK_SECRET_KEY) must be set to sign unsubscribe tokens');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function hmac(payload: string): string {
  return crypto.createHmac('sha256', signingKey()).update(`unsub:${payload}`).digest('base64url');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function signUnsubscribeToken(email: string, listType: EmailListType): string {
  const payload = `${listType}:${normalizeEmail(email)}`;
  const body = Buffer.from(payload, 'utf8').toString('base64url');
  return `${body}.${hmac(payload)}`;
}

/**
 * Verify a token and recover its claim, or null if it's malformed, tampered, or
 * carries an unknown list. Pure — no database.
 */
export function verifyUnsubscribeToken(
  token: string,
): { email: string; listType: EmailListType } | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(body, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const colon = payload.indexOf(':');
  if (colon < 1) return null;
  const listType = payload.slice(0, colon) as EmailListType;
  const email = payload.slice(colon + 1);
  if (!LIST_TYPES.includes(listType) || !email) return null;
  return { email, listType };
}

/** Record an opt-out. Idempotent: a repeat unsubscribe is a no-op. */
export async function suppressEmail(email: string, listType: EmailListType): Promise<void> {
  const e = normalizeEmail(email);
  if (!e) return;
  const { error } = await supabase
    .from('EmailSuppression')
    .upsert({ email: e, listType }, { onConflict: 'email,listType', ignoreDuplicates: true });
  if (error) logger.warn('[email] suppressEmail failed', { listType, error: error.message });
}

/** True if this address has opted out of this list. Fail-open (false) on error. */
export async function isEmailSuppressed(email: string, listType: EmailListType): Promise<boolean> {
  const e = normalizeEmail(email);
  if (!e) return false;
  const { data } = await supabase
    .from('EmailSuppression')
    .select('id')
    .eq('email', e)
    .eq('listType', listType)
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
}

export function unsubscribeUrl(email: string, listType: EmailListType): string {
  const token = encodeURIComponent(signUnsubscribeToken(email, listType));
  return `${appUrl()}/api/unsubscribe?token=${token}`;
}

/**
 * RFC 8058 one-click headers for Resend's `headers` field, so Gmail/Apple Mail
 * render the inbox-level "Unsubscribe" affordance and POST it on click.
 */
export function unsubscribeHeaders(email: string, listType: EmailListType): Record<string, string> {
  const url = unsubscribeUrl(email, listType);
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/** Visible opt-out footer — CAN-SPAM requires the link be human-clickable too. */
export function unsubscribeFooterHtml(email: string, listType: EmailListType): string {
  const url = unsubscribeUrl(email, listType);
  return `<p style="color:#9ca3af;font-size:11px;margin-top:18px;line-height:1.5">You're receiving this weekly summary from Cola. <a href="${url}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a>.</p>`;
}
