import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { convex, api } from '@/lib/convex-server';

/**
 * GET /api/platform/announcements
 * Returns active announcements targeted at the current user, excluding ones
 * they have already dismissed. Segment matching:
 *   - 'all'       → everyone
 *   - 'trial'     → Space.stripeSubscriptionStatus = 'trialing'
 *   - 'active'    → Space.stripeSubscriptionStatus = 'active'
 *   - 'past_due'  → Space.stripeSubscriptionStatus = 'past_due'
 *   - 'admin'     → User.platformRole = 'admin'
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Look up the current user and their primary space (for subscription status).
  // The User row and its owned Space live in separate Convex domains, so the old
  // PostgREST `Space(...)` embed becomes two reads: User by clerkId, then the
  // owner's single Space (Space.ownerId is unique → the user's primary space).
  const user = await convex().query(api.org.users.getByClerkId, { clerkId: userId });
  const space = user
    ? await convex().query(api.workspace.spaces.getByOwnerId, { ownerId: user.id })
    : null;
  const subStatus: string | null = space?.stripeSubscriptionStatus ?? null;
  const isAdmin = user?.platformRole === 'admin';

  // Determine which segments apply to this user.
  const segments: string[] = ['all'];
  if (subStatus === 'trialing') segments.push('trial');
  if (subStatus === 'active') segments.push('active');
  if (subStatus === 'past_due') segments.push('past_due');
  if (isAdmin) segments.push('admin');

  const now = new Date().toISOString();

  const all = await convex().query(api.notifications.announcements.listActiveForSegments, {
    segments,
    now,
  });

  if (all.length === 0) return NextResponse.json({ announcements: [] });

  // Filter out ones this user has dismissed.
  const ids = all.map((a) => a.id);
  const dismissedIds = await convex().query(
    api.notifications.dismissals.dismissedIdsForUser,
    { userId, announcementIds: ids },
  );
  const dismissed = new Set(dismissedIds);
  const filtered = all.filter((a) => !dismissed.has(a.id));

  return NextResponse.json({ announcements: filtered });
}
