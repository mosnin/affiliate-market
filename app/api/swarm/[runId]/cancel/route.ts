import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

// ── POST /api/swarm/[runId]/cancel ────────────────────────────────────────────
// Cancel a swarm run that is currently queued, planning, running, or auditing.

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const { runId } = await params;

  const space = await getSpaceForUser(userId);
  if (!space) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Atomic compare-and-set: verify the run is in this space, confirm it's still
  // cancellable, and flip it to 'cancelled' in one mutation. The reason string
  // maps the two failure modes back onto the original 404 / 400 responses.
  let result;
  try {
    result = await convex().mutation(api.swarmvector.swarmRuns.cancel, {
      id: runId,
      spaceId: space.id,
    });
  } catch (updateError) {
    console.error('[swarm/[runId]/cancel/POST] cancel error:', updateError);
    return NextResponse.json({ error: 'Failed to cancel run' }, { status: 500 });
  }

  if (!result.ok) {
    if (result.reason === 'not_found') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: 'Run cannot be cancelled in its current state' },
      { status: 400 },
    );
  }

  // Append a cancellation event to the event log.
  try {
    await convex().mutation(api.swarmvector.swarmEvents.append, {
      swarmRunId: runId,
      type: 'swarm_cancelled',
      data: { reason: 'user_cancelled' },
    });
  } catch (eventError) {
    console.error('[swarm/[runId]/cancel/POST] event insert error:', eventError);
    // Run is already cancelled — don't fail the request over a missing event row.
  }

  return NextResponse.json({ success: true });
}
