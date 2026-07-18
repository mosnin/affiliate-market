import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const body = await req.json();
  const { answer } = body;

  if (typeof answer !== 'string' || answer.length < 1 || answer.length > 2000) {
    return NextResponse.json(
      { error: 'answer must be between 1 and 2000 characters' },
      { status: 400 },
    );
  }

  // Verify ownership + flip pending→answered in one mutation. The pending guard
  // (409) and the not-in-space check (404) are enforced inside `answer`.
  const result = await convex().mutation(api.agent.questions.answer, {
    id,
    spaceId: space.id,
    answer,
  });

  if (result.outcome === 'not_found') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (result.outcome === 'conflict') {
    return NextResponse.json(
      { error: `Question is already ${result.question?.status}` },
      { status: 409 },
    );
  }

  return NextResponse.json(result.question);
}
