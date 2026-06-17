/**
 * GET /api/agent/contact-context/[contactId]
 * Returns the active goal type and most recent agent action for a contact.
 */
import { NextRequest, NextResponse } from 'next/server';
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
  const contact = await convex()
    .query(api.contacts.contacts.getById, { id: contactId, spaceId: space.id })
    .catch(() => null);
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [goalType, activityRows] = await Promise.all([
    // Highest-priority active goal's goalType for this contact (Convex).
    convex().query(api.agent.goals.activeGoalTypeForContact, {
      spaceId: space.id,
      contactId,
    }),

    // Most recent [Agent]%/[Outcome]% timeline entry — the PG
    // `.or(content.like.[Agent]%,content.like.[Outcome]%)` becomes the
    // contentPrefixAny filter; newest-first, capped at 1.
    convex().query(api.contacts.activity.listForContact, {
      contactId,
      spaceId: space.id,
      contentPrefixAny: ['[Agent]', '[Outcome]'],
      limit: 1,
    }),
  ]);
  let lastAction: string | null = null;
  const lastActivity = activityRows[0];
  if (lastActivity?.content) {
    lastAction = lastActivity.content
      .replace(/^\[Agent\]\s*/, '')
      .replace(/^\[Outcome\]\s*/, '')
      .slice(0, 80);
  }

  return NextResponse.json({ goalType, lastAction });
}
