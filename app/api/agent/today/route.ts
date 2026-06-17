/**
 * GET /api/agent/today
 *
 * Returns the day's items for the dispatch console's "What's coming" section:
 *   - followUpsDue: contacts whose followUpAt is in the past or today
 *   - demosUpcoming: scheduled or confirmed demos from now forward
 *
 * One endpoint, one shape — keeps the dispatch console rendering one fetch
 * per section instead of N. Seller space only (not company-routed).
 */
import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

export interface FollowUpDue {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  type: string | null;
  followUpAt: string;
  leadScore: number | null;
  scoreLabel: string | null;
}

export interface UpcomingDemo {
  id: string;
  guestName: string | null;
  startsAt: string;
  endsAt: string | null;
  productAddress: string | null;
  status: string;
}

export async function GET(_req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const nowIso = new Date().toISOString();

  const [followUpRows, demosUpcoming] = await Promise.all([
    // followUpAt-due, companyId-null, ASC by followUpAt, capped 10 — the old
    // `.is('companyId',null).not(followUpAt,is,null).lte(followUpAt,now)` query.
    convex()
      .query(api.contacts.contacts.followUpsForSpaces, {
        spaceIds: [space.id],
        lte: nowIso,
        requireCompanyIdNull: true,
        limit: 10,
      })
      .catch(() => []),
    convex().query(api.demos.demos.listBySpace, {
      spaceId: space.id,
      startsAtGte: nowIso,
      statuses: ['scheduled', 'confirmed'],
      order: 'asc',
      limit: 6,
    }),
  ]);

  return NextResponse.json({
    followUpsDue: followUpRows as unknown as FollowUpDue[],
    demosUpcoming: demosUpcoming as UpcomingDemo[],
  });
}
