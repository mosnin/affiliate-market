/**
 * DELETE /api/agent/memory/[id]
 *
 * Removes one of Cola's long-term memories. Scoped to the caller's space —
 * memories outside the caller's space return 404 indistinguishable from
 * non-existent rows so we don't leak existence across tenants.
 *
 * Editing memory content isn't supported in v1: the AgentMemory row carries a
 * vector embedding generated at write time, and editing without re-embedding
 * silently degrades retrieval. Until we wire re-embed-on-edit, the correction
 * pattern is "delete the wrong fact; let Cola re-learn it."
 */
import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // removeInSpace folds the existence-in-space check and the delete into one
  // mutation. ok:false means "not in this space" — returned as a 404
  // indistinguishable from a non-existent row, matching the original behaviour.
  let result;
  try {
    result = await convex().mutation(api.swarmvector.agentMemory.removeInSpace, {
      id,
      spaceId: space.id,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  if (!result.ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
