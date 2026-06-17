import { convex, api } from '@/lib/convex-server';
import { isPlatformAdmin } from '@/lib/permissions';
import { redirect } from 'next/navigation';
import { BroadcastClient, type SegmentKey, type PastBroadcast } from './broadcast-client';

export const metadata = { title: 'Broadcast — Admin — Cola' };

const SUBSCRIPTION_SEGMENTS: Record<string, string> = {
  trial: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
};

async function countSegment(segment: SegmentKey): Promise<number> {
  if (segment === 'all') {
    const { total } = await convex().query(api.org.users.counts, {});
    return total;
  }
  if (segment === 'onboarded' || segment === 'not_onboarded') {
    const { total, onboarded } = await convex().query(api.org.users.counts, {});
    return segment === 'onboarded' ? onboarded : Math.max(0, total - onboarded);
  }
  if (segment in SUBSCRIPTION_SEGMENTS) {
    return convex().query(api.workspace.spaces.countBySubscriptionStatus, {
      status: SUBSCRIPTION_SEGMENTS[segment],
    });
  }
  if (segment === 'no_workspace') {
    const [{ total: totalUsers }, allSpaces] = await Promise.all([
      convex().query(api.org.users.counts, {}),
      // No "count all spaces" fn — the unfiltered list's length is the total.
      convex().query(api.workspace.spaces.listBySubscriptionStatus, {}),
    ]);
    return Math.max(0, totalUsers - allSpaces.length);
  }
  return 0;
}

export default async function AdminBroadcastPage() {
  const isAdmin = await isPlatformAdmin();
  if (!isAdmin) redirect('/');

  const segmentKeys: SegmentKey[] = [
    'all',
    'onboarded',
    'not_onboarded',
    'trial',
    'active',
    'past_due',
    'canceled',
    'no_workspace',
  ];

  // EmailBroadcast moved to Convex; the per-segment counts (User/Space) stay on
  // Supabase — this page is a hybrid read during the cutover.
  const [countsArr, pastRows] = await Promise.all([
    Promise.all(segmentKeys.map((k) => countSegment(k))),
    convex().query(api.support.broadcasts.listRecent, { limit: 20 }),
  ]);

  const counts: Record<SegmentKey, number> = segmentKeys.reduce(
    (acc, key, i) => {
      acc[key] = countsArr[i];
      return acc;
    },
    {} as Record<SegmentKey, number>,
  );

  const pastBroadcasts = (pastRows as PastBroadcast[]).map((b) => ({
    id: b.id,
    subject: b.subject,
    segment: b.segment,
    recipientCount: b.recipientCount,
    sentCount: b.sentCount,
    failedCount: b.failedCount,
    sentBy: b.sentBy,
    createdAt: typeof b.createdAt === 'string' ? b.createdAt : String(b.createdAt),
  }));

  return (
    <div className="space-y-8 pb-12">
      <header className="space-y-1.5">
        <p className="text-sm text-muted-foreground">Growth.</p>
        <h1
          className="text-3xl tracking-tight text-foreground"
          style={{ fontFamily: 'var(--font-title)' }}
        >
          Email broadcast
        </h1>
        <p className="text-sm text-muted-foreground">
          Send an email to a segment of users. Limited to 3 broadcasts per hour.
        </p>
      </header>
      <BroadcastClient counts={counts} pastBroadcasts={pastBroadcasts} />
    </div>
  );
}
