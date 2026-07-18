import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requirePlatformAdmin } from '@/lib/permissions';
import { checkRateLimit } from '@/lib/rate-limit';
import { logAdminAction } from '@/lib/admin';
import { hideReview, unhideReview } from '@/lib/marketplace/reviews';

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/admin/reviews/[id] — platform admin moderates a review.
 * Body { status: 'published' | 'hidden' }. Hiding keeps the buyer's words
 * in the table (reversible) rather than deleting them.
 */
export async function PATCH(req: Request, { params }: Params) {
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

  const body = (await req.json().catch(() => ({}))) as { status?: unknown };
  if (body.status !== 'published' && body.status !== 'hidden') {
    return NextResponse.json({ error: 'status must be published or hidden' }, { status: 400 });
  }

  const ok = body.status === 'hidden' ? await hideReview(id) : await unhideReview(id);
  if (!ok) return NextResponse.json({ error: 'Could not update review' }, { status: 500 });

  await logAdminAction({
    actor: admin.clerkUserId,
    action: body.status === 'hidden' ? 'hide_review' : 'unhide_review',
    target: id,
    details: { status: body.status },
  });

  return NextResponse.json({ ok: true, status: body.status });
}
