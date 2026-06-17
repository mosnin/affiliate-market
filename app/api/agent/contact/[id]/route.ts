/**
 * GET /api/agent/contact/[id]
 *
 * Returns agent intelligence context for a single contact:
 *   - memories (facts + observations stored by agents across runs)
 *   - pending drafts for this contact
 *   - recent agent activity log entries
 *
 * Secured with Clerk auth. Contact must belong to the caller's space.
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

  const { id: contactId } = await params;

  // Verify contact belongs to this space
  const { data: contact, error: contactError } = await supabase
    .from('Contact')
    .select('id, name')
    .eq('id', contactId)
    .eq('spaceId', space.id)
    .maybeSingle();

  if (contactError) throw contactError;
  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

  const [memories, drafts, activity] = await Promise.all([
    convex().query(api.swarmvector.agentMemory.listForEntity, {
      spaceId: space.id,
      entityType: 'contact',
      entityId: contactId,
      limit: 20,
    }),

    convex().query(api.agent.drafts.listForContact, {
      spaceId: space.id,
      contactId,
      statuses: ['pending', 'approved'],
      limit: 10,
    }),

    // Old SELECT named non-existent columns (`action`, `summary`, `contactId`);
    // real columns are actionType, reasoning, relatedContactId. The Convex fn
    // returns the real columns — same 15-row, createdAt-desc scope.
    convex().query(api.agent.activity.contextForContact, {
      spaceId: space.id,
      contactId,
      limit: 15,
    }),
  ]);

  return NextResponse.json({
    contactId,
    memories: memories ?? [],
    drafts,
    activity,
  });
}
