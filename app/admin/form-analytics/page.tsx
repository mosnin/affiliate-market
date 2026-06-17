import { convex, api } from '@/lib/convex-server';
import { isPlatformAdmin } from '@/lib/permissions';
import { redirect } from 'next/navigation';
import { FormAnalyticsClient } from './form-analytics-client';

export const metadata = { title: 'Form Analytics — Admin — Cola' };

export type ScoreDistribution = {
  hot: number;
  warm: number;
  cold: number;
  unqualified: number;
};

export type CompanySubmissionRow = {
  companyId: string;
  companyName: string | null;
  count: number;
};

export type SpaceSubmissionRow = {
  spaceId: string;
  spaceName: string | null;
  spaceSlug: string | null;
  count: number;
};

export type SourceRow = { source: string; count: number };
export type TrendPoint = { date: string; count: number };

const FORM_TAGS = ['application-link', 'company-lead'];

export default async function FormAnalyticsPage() {
  const isAdmin = await isPlatformAdmin();
  if (!isAdmin) redirect('/');

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  let totalSubmissions = 0;
  let submissions7d = 0;
  let submissions30d = 0;
  let avgScore = 0;
  let distribution: ScoreDistribution = { hot: 0, warm: 0, cold: 0, unqualified: 0 };
  let emptyApplications = 0;
  let topCompanies: CompanySubmissionRow[] = [];
  let topSpaces: SpaceSubmissionRow[] = [];
  let trend: TrendPoint[] = [];
  let perSource: SourceRow[] = [];

  try {
    const [
      totalCount,
      sevenCount,
      thirtyCount,
      scoreRowsRes,
      distRes,
      emptyRows,
      companyRowsRes,
      spaceRowsRes,
      trendRowsRes,
      sourceRowsRes,
    ] = await Promise.all([
      convex().query(api.contacts.contacts.countAll, { tagsAny: FORM_TAGS }),
      convex().query(api.contacts.contacts.countAll, {
        tagsAny: FORM_TAGS,
        createdGte: sevenDaysAgo,
      }),
      convex().query(api.contacts.contacts.countAll, {
        tagsAny: FORM_TAGS,
        createdGte: thirtyDaysAgo,
      }),
      convex().query(api.contacts.contacts.scanForAnalytics, {
        tagsAny: FORM_TAGS,
        requireLeadScoreNotNull: true,
        limit: 5000,
      }),
      convex().query(api.contacts.contacts.scanForAnalytics, {
        tagsAny: FORM_TAGS,
        requireScoreLabelNotNull: true,
        limit: 5000,
      }),
      // No applicationData-null predicate on countAll — scan the tagged population
      // and count the rows with null applicationData (unbounded, matching the old
      // exact count).
      convex().query(api.contacts.contacts.scanForAnalytics, { tagsAny: FORM_TAGS }),
      convex().query(api.contacts.contacts.scanForAnalytics, {
        tagsAny: FORM_TAGS,
        limit: 5000,
      }),
      convex().query(api.contacts.contacts.scanForAnalytics, {
        tagsAny: FORM_TAGS,
        limit: 5000,
      }),
      convex().query(api.contacts.contacts.scanForAnalytics, {
        tagsAny: FORM_TAGS,
        createdGte: thirtyDaysAgo,
      }),
      convex().query(api.contacts.contacts.scanForAnalytics, {
        tagsAny: FORM_TAGS,
        limit: 5000,
      }),
    ]);

    totalSubmissions = totalCount ?? 0;
    submissions7d = sevenCount ?? 0;
    submissions30d = thirtyCount ?? 0;
    emptyApplications = (emptyRows as { applicationData: unknown }[]).filter(
      (r) => r.applicationData == null,
    ).length;

    const scoreRows = (scoreRowsRes ?? []) as { leadScore: number | null }[];
    if (scoreRows.length > 0) {
      const sum = scoreRows.reduce((a, r) => a + (r.leadScore ?? 0), 0);
      avgScore = Math.round((sum / scoreRows.length) * 10) / 10;
    }

    for (const row of (distRes ?? []) as { scoreLabel: string | null }[]) {
      const label = (row.scoreLabel ?? '').toLowerCase();
      if (label === 'hot') distribution.hot++;
      else if (label === 'warm') distribution.warm++;
      else if (label === 'cold') distribution.cold++;
      else if (label === 'unqualified') distribution.unqualified++;
    }

    // Top companies
    const companyCounts = new Map<string, number>();
    for (const r of (companyRowsRes ?? []) as { companyId: string | null }[]) {
      if (!r.companyId) continue;
      companyCounts.set(r.companyId, (companyCounts.get(r.companyId) ?? 0) + 1);
    }
    const topCompanyIds = Array.from(companyCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (topCompanyIds.length > 0) {
      const ids = topCompanyIds.map(([id]) => id);
      const companyNames = await convex().query(api.org.companies.listByIds, { ids });
      const nameById = new Map<string, string>();
      for (const b of (companyNames ?? []) as { id: string; name: string | null }[]) {
        if (b.name) nameById.set(b.id, b.name);
      }
      topCompanies = topCompanyIds.map(([id, count]) => ({
        companyId: id,
        companyName: nameById.get(id) ?? null,
        count,
      }));
    }

    // Top spaces — resolve seller name/slug from Space (the old PostgREST embed)
    // in one batch lookup over the spaceIds present in the tagged population.
    const spaceRows = (spaceRowsRes ?? []) as { spaceId: string }[];
    const spaceIds = Array.from(
      new Set(spaceRows.map((r) => r.spaceId).filter((id): id is string => Boolean(id))),
    );
    const spaceInfo = new Map<string, { name: string | null; slug: string | null }>();
    if (spaceIds.length > 0) {
      const sRows = await convex().query(api.workspace.spaces.listByIds, { ids: spaceIds });
      for (const s of (sRows ?? []) as { id: string; name: string | null; slug: string | null }[]) {
        spaceInfo.set(s.id, { name: s.name ?? null, slug: s.slug ?? null });
      }
    }
    const spaceCounts = new Map<string, SpaceSubmissionRow>();
    for (const r of spaceRows) {
      if (!r.spaceId) continue;
      const sp = spaceInfo.get(r.spaceId);
      const existing = spaceCounts.get(r.spaceId);
      if (existing) {
        existing.count += 1;
      } else {
        spaceCounts.set(r.spaceId, {
          spaceId: r.spaceId,
          spaceName: sp?.name ?? null,
          spaceSlug: sp?.slug ?? null,
          count: 1,
        });
      }
    }
    topSpaces = Array.from(spaceCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Trend (30-day, per-day)
    const dayMap: Record<string, number> = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86_400_000);
      dayMap[d.toISOString().slice(0, 10)] = 0;
    }
    for (const row of (trendRowsRes ?? []) as { createdAt: string }[]) {
      const day = new Date(row.createdAt).toISOString().slice(0, 10);
      if (day in dayMap) dayMap[day]++;
    }
    trend = Object.entries(dayMap).map(([date, count]) => ({ date, count }));

    // Source funnel
    const srcCounts = new Map<string, number>();
    for (const r of (sourceRowsRes ?? []) as { sourceLabel: string | null }[]) {
      const key = r.sourceLabel || 'unknown';
      srcCounts.set(key, (srcCounts.get(key) ?? 0) + 1);
    }
    perSource = Array.from(srcCounts.entries())
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);
  } catch (err) {
    console.error('[admin/form-analytics] query failed', err);
  }

  return (
    <FormAnalyticsClient
      stats={{
        totalSubmissions,
        submissions7d,
        submissions30d,
        avgScore,
        emptyApplications,
      }}
      distribution={distribution}
      topCompanies={topCompanies}
      topSpaces={topSpaces}
      trend={trend}
      perSource={perSource}
    />
  );
}
