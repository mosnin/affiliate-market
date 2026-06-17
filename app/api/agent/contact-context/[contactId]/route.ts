/**
 * GET /api/agent/contact-context/[contactId]
 * Returns the active goal type and most recent agent action for a contact.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ contactId: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { contactId } = await params;

  // Validate contact belongs to this space
  const { data: contact } = await supabase
    .from('Contact')
    .select('id')
    .eq('id', contactId)
    .eq('spaceId', space.id)
    .maybeSingle();
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [goalType, activityRes] = await Promise.all([
    // Highest-priority active goal's goalType for this contact (Convex).
    convex().query(api.agent.goals.activeGoalTypeForContact, {
      spaceId: space.id,
      contactId,
    }),

    supabase
      .from('ContactActivity')
      .select('content, createdAt')
      .eq('spaceId', space.id)
      .eq('contactId', contactId)
      .or('content.like.[Agent]%,content.like.[Outcome]%')
      .order('createdAt', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  let lastAction: string | null = null;
  if (activityRes.data?.content) {
    lastAction = activityRes.data.content
      .replace(/^\[Agent\]\s*/, '')
      .replace(/^\[Outcome\]\s*/, '')
      .slice(0, 80);
  }

  return NextResponse.json({ goalType, lastAction });
}
