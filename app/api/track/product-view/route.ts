import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { recordProductView } from '@/lib/marketplace/views';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

/**
 * Public product-view beacon, hit by <ViewBeacon /> on the marketplace product
 * detail page. Always answers 200 with { ok } — a tracking endpoint must never
 * tell the caller whether a productId exists or not, and a failure here must
 * never surface to the visitor. Rate-limited per IP, same as /track/click.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const { allowed } = await checkRateLimit(`track-view:${ip}`, 60, 60);
  if (!allowed) return NextResponse.json({ ok: false }, { status: 429 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const productId = typeof body.productId === 'string' ? body.productId.trim().slice(0, 64) : '';
  if (!productId) return NextResponse.json({ ok: false }, { status: 400 });

  const ipHash = ip && ip !== 'unknown'
    ? createHash('sha256').update(ip).digest('hex').slice(0, 32)
    : null;

  const ok = await recordProductView({
    productId,
    visitorId: typeof body.visitorId === 'string' ? body.visitorId.slice(0, 64) : null,
    ipHash,
  });

  return NextResponse.json({ ok });
}
