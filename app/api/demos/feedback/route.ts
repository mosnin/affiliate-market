import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireSpaceOwner } from '@/lib/api-auth';
import { checkRateLimit } from '@/lib/rate-limit';

/**
 * POST — Submit demo feedback (from guest, token-based).
 * GET  — Get feedback for a demo (agent, authenticated).
 */
export async function POST(req: NextRequest) {
  const { token, rating, comment } = await req.json();

  // Guest feedback must always be submitted via the manage token.
  // Accepting a bare demoId would allow anyone who guesses/enumerates a UUID
  // to spam or overwrite feedback without any guest-side authorization.
  if (!token) {
    return NextResponse.json({ error: 'token required' }, { status: 400 });
  }

  // Rate limit by token to prevent spam
  const rlKey = `feedback:${token}`;
  const { allowed } = await checkRateLimit(rlKey, 3, 3600);
  if (!allowed) return NextResponse.json({ error: 'Too many attempts' }, { status: 429 });

  if (!rating || rating < 1 || rating > 5) {
    return NextResponse.json({ error: 'Rating must be 1-5' }, { status: 400 });
  }

  // Verify demo access via manage token only
  const demo = await convex().query(api.demos.demos.getByManageToken, { manageToken: token });

  if (!demo) {
    return NextResponse.json({ error: 'Demo not found' }, { status: 404 });
  }

  if (demo.status !== 'completed') {
    return NextResponse.json({ error: 'Feedback only accepted for completed demos' }, { status: 400 });
  }

  // Create with the one-per-demo existence check folded into the mutation;
  // null return means feedback already exists.
  const feedback = await convex().mutation(api.demos.feedback.create, {
    demoId: demo.id,
    spaceId: demo.spaceId,
    rating: Math.round(rating),
    comment: typeof comment === 'string' ? comment.trim().slice(0, 2000) || null : null,
  });

  if (!feedback) {
    return NextResponse.json({ error: 'Feedback already submitted' }, { status: 409 });
  }

  return NextResponse.json(feedback, { status: 201 });
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug');
  const demoId = req.nextUrl.searchParams.get('demoId');

  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;

  if (demoId) {
    const data = await convex().query(api.demos.feedback.getByDemo, {
      demoId,
      spaceId: auth.space.id,
    });
    if (!data) return NextResponse.json(null);
    return NextResponse.json(data);
  }

  // Return all feedback for this space
  const data = await convex().query(api.demos.feedback.listBySpace, {
    spaceId: auth.space.id,
  });

  return NextResponse.json(data);
}
