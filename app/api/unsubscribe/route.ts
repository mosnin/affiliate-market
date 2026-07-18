/**
 * Marketing-email one-click unsubscribe — CAN-SPAM + RFC 8058.
 *
 * GET and POST both accept ?token=<signed token>. The token is the stateless,
 * HMAC-signed value minted by lib/email/suppression.ts and embedded in every
 * creator/seller weekly digest. It carries the recipient address and which list
 * to leave; no login and no pre-stored token row are needed. A valid hit writes
 * one EmailSuppression row, and future digest sends skip that address.
 *
 * Gmail / Apple Mail fire a POST when the user clicks the inbox-level
 * "Unsubscribe" affordance (paired with the List-Unsubscribe-Post header the
 * digest sets). A forged or corrupt token can't unsubscribe anyone — the HMAC
 * won't verify — so an invalid token returns 400 rather than silently 200.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyUnsubscribeToken, suppressEmail, type EmailListType } from '@/lib/email/suppression';

const LABEL: Record<EmailListType, string> = {
  creator_digest: 'creator weekly digest',
  seller_digest: 'seller weekly digest',
};

async function unsubscribe(token: string): Promise<NextResponse> {
  const claim = verifyUnsubscribeToken(token);
  if (!claim) {
    return htmlResponse('This unsubscribe link is invalid or has expired.', 400);
  }
  await suppressEmail(claim.email, claim.listType);
  return htmlResponse(`You're unsubscribed from the ${LABEL[claim.listType]}.`, 200);
}

export async function GET(req: NextRequest) {
  return unsubscribe(req.nextUrl.searchParams.get('token') ?? '');
}

export async function POST(req: NextRequest) {
  // RFC 8058: List-Unsubscribe-Post fires a POST. The token arrives in the
  // query string (Gmail's behavior) or as form data on some clients.
  const fromQuery = req.nextUrl.searchParams.get('token');
  if (fromQuery) return unsubscribe(fromQuery);

  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = await req.formData();
    const token = form.get('token');
    if (typeof token === 'string') return unsubscribe(token);
  }
  return NextResponse.json({ error: 'Missing token.' }, { status: 400 });
}

function htmlResponse(message: string, status: number): NextResponse {
  const body = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Unsubscribe</title></head>
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:48px 16px;color:#111827">
  <p style="font-size:14px;color:#6b7280;margin:0 0 12px">Cola</p>
  <p style="font-size:18px;margin:0">${message}</p>
</body>
</html>`;
  return new NextResponse(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
