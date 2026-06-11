import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { recordClick } from '@/lib/affiliates/tracking';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

/**
 * Public click-tracking endpoint, hit by <ReferralTracker /> when a visitor
 * lands with ?via=CODE / ?ref=CODE. Always answers 200 with { ok } — the
 * response must never leak whether a code exists.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const { allowed } = await checkRateLimit(`track-click:${ip}`, 30, 60);
  if (!allowed) return NextResponse.json({ ok: false }, { status: 429 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const code = typeof body.code === 'string' ? body.code.trim().slice(0, 64) : '';
  if (!code) return NextResponse.json({ ok: false }, { status: 400 });

  const ipHash = ip ? createHash('sha256').update(ip).digest('hex').slice(0, 32) : null;

  const ok = await recordClick({
    code,
    landingUrl: typeof body.landingUrl === 'string' ? body.landingUrl : '',
    referrer: typeof body.referrer === 'string' ? body.referrer : null,
    visitorId: typeof body.visitorId === 'string' ? body.visitorId.slice(0, 64) : '',
    ipHash,
    userAgent: req.headers.get('user-agent'),
  });

  return NextResponse.json({ ok });
}
