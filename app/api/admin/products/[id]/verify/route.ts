import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requirePlatformAdmin } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit } from '@/lib/rate-limit';
import { logAdminAction } from '@/lib/admin';

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/admin/products/[id]/verify — platform admin sets a listing's
 * trust flag. Body { verified: boolean }. This is the ONLY write path for
 * Product.verified — the seller product API can't set it (see sanitiseBody),
 * so verification is always a platform decision, never a self-grant.
 */
export async function POST(req: Request, { params }: Params) {
  let admin: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const session = await auth();
  const { allowed } = await checkRateLimit(`admin:${session.userId}`, 60, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const { id } = await params;
  if (!id || !UUID.test(id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { verified?: unknown };
  if (typeof body.verified !== 'boolean') {
    return NextResponse.json({ error: 'verified must be a boolean' }, { status: 400 });
  }

  const data = await convex().mutation(api.marketplace.products.setVerified, {
    id,
    verified: body.verified,
  });

  if (!data) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 });
  }

  await logAdminAction({
    actor: admin.clerkUserId,
    action: body.verified ? 'verify_product' : 'unverify_product',
    target: id,
    details: { verified: body.verified },
  });

  return NextResponse.json({ ok: true, verified: data.verified });
}
