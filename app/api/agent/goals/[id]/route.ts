import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

const VALID_STATUSES = ['active', 'completed', 'cancelled', 'paused'] as const;
type GoalStatus = (typeof VALID_STATUSES)[number];

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

  if (!body.status || !(VALID_STATUSES as readonly string[]).includes(body.status)) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      { status: 400 },
    );
  }

  // Update status (Convex). Folds the ownership pre-read, the completedAt stamp
  // on 'completed', and the completionNotes metadata merge into one mutation.
  const result = await convex().mutation(api.agent.goals.updateStatus, {
    id,
    spaceId: space.id,
    status: body.status as GoalStatus,
    ...(body.completionNotes !== undefined ? { completionNotes: body.completionNotes } : {}),
  });

  if (!result.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json(result.goal);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;

  // Soft-delete → status 'cancelled' (Convex). Idempotent: an already-cancelled
  // goal still returns { cancelled: true }, matching the old 200 path.
  const result = await convex().mutation(api.agent.goals.cancel, { id, spaceId: space.id });
  if (result.outcome === 'not_found') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ cancelled: true });
}
