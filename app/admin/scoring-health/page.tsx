import { convex, api } from '@/lib/convex-server';
import { isPlatformAdmin } from '@/lib/permissions';
import { redirect } from 'next/navigation';
import { ScoringHealthClient } from './scoring-health-client';

export const metadata = { title: 'Scoring Health — Admin — Cola' };

export type SpaceFailureRow = {
  spaceId: string;
  spaceName: string | null;
  spaceSlug: string | null;
  failedCount: number;
};

export type FailedLeadRow = {
  id: string;
  name: string | null;
  spaceId: string;
  spaceSlug: string | null;
  spaceName: string | null;
  createdAt: string;
  scoreSummary: string | null;
};

export default async function ScoringHealthPage() {
  const isAdmin = await isPlatformAdmin();
  if (!isAdmin) redirect('/');

  const now = new Date();
  const last24hIso = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const last7dIso = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  let totalContacts = 0;
  let totalScored = 0;
  let totalFailed = 0;
  let totalPending = 0;
  let failed24h = 0;
  let failed7d = 0;
  let perSpace: SpaceFailureRow[] = [];
  let recentFailed: FailedLeadRow[] = [];

  try {
    const [
      totalContactsCount,
      scoredCount,
      failedCount,
      pendingCount,
      failed24hCount,
      failed7dCount,
      allFailed,
      recentFailedRows,
    ] = await Promise.all([
      convex().query(api.contacts.contacts.countAll, {}),
      convex().query(api.contacts.contacts.countAll, { scoringStatus: 'scored' }),
      convex().query(api.contacts.contacts.countAll, { scoringStatus: 'failed' }),
      convex().query(api.contacts.contacts.countAll, { scoringStatus: 'pending' }),
      convex().query(api.contacts.contacts.countAll, {
        scoringStatus: 'failed',
        createdGte: last24hIso,
      }),
      convex().query(api.contacts.contacts.countAll, {
        scoringStatus: 'failed',
        createdGte: last7dIso,
      }),
      // All failed contacts so we can aggregate top-10 spaces (scanForAnalytics
      // returns full rows newest-first; Space(slug,name) is resolved below).
      convex().query(api.contacts.contacts.scanForAnalytics, {
        scoringStatus: 'failed',
        limit: 5000,
      }),
      convex().query(api.contacts.contacts.scanForAnalytics, {
        scoringStatus: 'failed',
        limit: 50,
      }),
    ]);

    totalContacts = totalContactsCount;
    totalScored = scoredCount;
    totalFailed = failedCount;
    totalPending = pendingCount;
    failed24h = failed24hCount;
    failed7d = failed7dCount;

    type FailedContact = {
      id: string;
      name: string | null;
      spaceId: string;
      createdAt: string;
      scoreSummary: string | null;
    };
    const allFailedRows = allFailed as FailedContact[];
    const recentRows = recentFailedRows as FailedContact[];

    // Resolve the embedded Space(slug,name) for every spaceId across both scans.
    const spaceIds = Array.from(
      new Set([...allFailedRows, ...recentRows].map((r) => r.spaceId).filter(Boolean)),
    );
    const spaces =
      spaceIds.length > 0
        ? ((await convex().query(api.workspace.spaces.listByIds, { ids: spaceIds })) as Array<{
            id: string;
            slug: string | null;
            name: string | null;
          }>)
        : [];
    const spaceById = new Map(spaces.map((s) => [s.id, s]));

    const counts = new Map<string, SpaceFailureRow>();
    for (const row of allFailedRows) {
      if (!row.spaceId) continue;
      const sp = spaceById.get(row.spaceId) ?? null;
      const existing = counts.get(row.spaceId);
      if (existing) {
        existing.failedCount += 1;
      } else {
        counts.set(row.spaceId, {
          spaceId: row.spaceId,
          spaceName: sp?.name ?? null,
          spaceSlug: sp?.slug ?? null,
          failedCount: 1,
        });
      }
    }
    perSpace = Array.from(counts.values())
      .sort((a, b) => b.failedCount - a.failedCount)
      .slice(0, 10);

    recentFailed = recentRows.map((r) => {
      const sp = spaceById.get(r.spaceId) ?? null;
      return {
        id: r.id,
        name: r.name,
        spaceId: r.spaceId,
        createdAt: r.createdAt,
        scoreSummary: r.scoreSummary,
        spaceSlug: sp?.slug ?? null,
        spaceName: sp?.name ?? null,
      };
    });
  } catch (err) {
    console.error('[admin/scoring-health] query failed', err);
  }

  return (
    <ScoringHealthClient
      stats={{
        totalContacts,
        totalScored,
        totalFailed,
        totalPending,
        failed24h,
        failed7d,
      }}
      perSpace={perSpace}
      failedLeads={recentFailed}
    />
  );
}
