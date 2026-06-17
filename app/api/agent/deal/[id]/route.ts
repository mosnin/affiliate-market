/**
 * GET /api/agent/deal/[id]
 *
 * Returns agent intelligence context for a single deal:
 *   - memories (facts + observations stored about this deal)
 *   - recent agent activity log entries for this deal
 *
 * Secured with Clerk auth. Deal must belong to the caller's space.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id: dealId } = await params;

  // Verify deal belongs to this space
  const { data: deal, error: dealError } = await supabase
    .from('Deal')
    .select('id, title')
    .eq('id', dealId)
    .eq('spaceId', space.id)
    .maybeSingle();

  if (dealError) throw dealError;
  if (!deal) return NextResponse.json({ error: 'Deal not found' }, { status: 404 });

  const [memories, activity] = await Promise.all([
    convex().query(api.swarmvector.agentMemory.listForEntity, {
      spaceId: space.id,
      entityType: 'deal',
      entityId: dealId,
      limit: 20,
    }),

    // The old SELECT named non-existent columns (`action`, `summary`, `dealId`);
    // the table's real columns are actionType, reasoning, relatedDealId. The
    // Convex fn returns those real columns (id, agentType, actionType, outcome,
    // reasoning, relatedDealId, createdAt) — same 15-row, createdAt-desc scope.
    convex().query(api.agent.activity.contextForDeal, {
      spaceId: space.id,
      dealId,
      limit: 15,
    }),
  ]);

  return NextResponse.json({
    dealId,
    memories: memories ?? [],
    activity,
  });
}
