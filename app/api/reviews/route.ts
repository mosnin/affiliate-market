import { NextResponse, type NextRequest } from 'next/server';
import { getClientUser } from '@/lib/client-auth';
import { createReview } from '@/lib/marketplace/reviews';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * POST /api/reviews — a buyer leaves a review.
 *
 * Buyer-session gated (the magic-code ClientUser session, not Clerk). The
 * purchased-before-review check lives in createReview: it refuses to write
 * unless this buyer has a PAID order for the product. One review per buyer per
 * product (unique index).
 */
export async function POST(req: NextRequest) {
  const user = await getClientUser();
  if (!user) return NextResponse.json({ error: 'Sign in to leave a review.' }, { status: 401 });
  if (!user.emailVerifiedAt) {
    return NextResponse.json({ error: 'Verify your email first.' }, { status: 403 });
  }

  const { allowed } = await checkRateLimit(`reviews:${user.id}`, 10, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });

  const body = (await req.json().catch(() => ({}))) as {
    productId?: string;
    rating?: number | string;
    title?: string;
    body?: string;
  };

  const productId = typeof body.productId === 'string' ? body.productId : '';
  if (!productId) return NextResponse.json({ error: 'Missing product.' }, { status: 400 });

  const result = await createReview({
    productId,
    buyerEmail: user.email,
    rating: Number(body.rating),
    title: body.title ?? null,
    body: body.body ?? null,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Could not save review.' }, { status: result.status ?? 400 });
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
