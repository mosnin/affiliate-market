import { getManagerContext } from '@/lib/permissions';
import { redirect } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { getSpaceByOwnerId } from '@/lib/space';
import { LeaderboardClient } from './leaderboard-client';
import { H1, TITLE_FONT, BODY_MUTED } from '@/lib/typography';
import { cn } from '@/lib/utils';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Leaderboard — Teams' };

export type SellerStats = {
  userId: string;
  name: string;
  email: string;
  avatar: string | null;
  totalLeads: number;
  dealsClosed: number;
  pipelineValue: number;
  demosCompleted: number;
  conversionRate: number;
  badges: string[];
};

export default async function LeaderboardPage() {
  const ctx = await getManagerContext();
  if (!ctx) redirect('/');

  const { company } = ctx;

  // Get all seller_members
  const { data: members } = await supabase
    .from('CompanyMembership')
    .select('userId')
    .eq('companyId', company.id)
    .eq('role', 'seller_member')
    .order('createdAt');

  if (!members?.length) {
    return (
      <div className="space-y-8 max-w-5xl mx-auto pb-56 md:pb-24">
        <header className="space-y-1.5">
          <h1 className={cn(H1)} style={TITLE_FONT}>
            Leaderboard
          </h1>
          <p className={cn(BODY_MUTED)}>No sellers to rank yet.</p>
        </header>
        <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-6 text-center">
          <p className={cn(BODY_MUTED, 'text-[13px]')}>
            I&apos;ll start ranking the team here once someone&apos;s on it.
          </p>
        </div>
      </div>
    );
  }

  // Fetch stats for each seller
  const stats: SellerStats[] = [];

  for (const member of members) {
    try {
      // User info
      const { data: user } = await supabase
        .from('User')
        .select('name, email, avatar')
        .eq('id', member.userId)
        .maybeSingle();

      if (!user) continue;

      // Seller's space
      const space = await getSpaceByOwnerId(member.userId);
      if (!space) {
        stats.push({
          userId: member.userId,
          name: user.name ?? user.email ?? 'Unknown',
          email: user.email ?? '',
          avatar: user.avatar ?? null,
          totalLeads: 0,
          dealsClosed: 0,
          pipelineValue: 0,
          demosCompleted: 0,
          conversionRate: 0,
          badges: [],
        });
        continue;
      }

      // Fetch all count-only stats and pipeline data in parallel
      const [totalLeadsRes, dealsClosedRes, activeDealsRes, demosCompletedCount] = await Promise.all([
        // Count total leads
        supabase
          .from('Contact')
          .select('*', { count: 'exact', head: true })
          .eq('spaceId', space.id),
        // Count deals won
        supabase
          .from('Deal')
          .select('*', { count: 'exact', head: true })
          .eq('spaceId', space.id)
          .eq('status', 'won'),
        // Pipeline value (need actual values for summing)
        supabase
          .from('Deal')
          .select('value')
          .eq('spaceId', space.id)
          .eq('status', 'active'),
        // Demos completed (count via length of the completed set)
        convex()
          .query(api.demos.demos.listBySpace, { spaceId: space.id, statuses: ['completed'] })
          .then((rows) => rows.length),
      ]);

      const pipelineValue = (activeDealsRes.data ?? []).reduce(
        (sum, d) => sum + (d.value ?? 0),
        0,
      );

      const leads = totalLeadsRes.count ?? 0;
      const closed = dealsClosedRes.count ?? 0;
      const conversionRate = leads > 0 ? Math.round((closed / leads) * 100) : 0;

      stats.push({
        userId: member.userId,
        name: user.name ?? user.email ?? 'Unknown',
        email: user.email ?? '',
        avatar: user.avatar ?? null,
        totalLeads: leads,
        dealsClosed: closed,
        pipelineValue,
        demosCompleted: demosCompletedCount,
        conversionRate,
        badges: [],
      });
    } catch (err) {
      console.error(`[leaderboard] Failed to fetch stats for member ${member.userId}:`, err);
      // Skip this member but continue processing others
    }
  }

  // Compute badges
  if (stats.length > 0) {
    // Top Closer — most deals closed
    const maxDeals = Math.max(...stats.map((s) => s.dealsClosed));
    if (maxDeals > 0) {
      stats.filter((s) => s.dealsClosed === maxDeals).forEach((s) => s.badges.push('Top Closer'));
    }

    // Fast Responder — highest conversion rate (proxy for response speed)
    const maxConv = Math.max(...stats.map((s) => s.conversionRate));
    if (maxConv > 0) {
      stats.filter((s) => s.conversionRate === maxConv).forEach((s) => s.badges.push('Fast Responder'));
    }

    // Hot Streak — most demos completed
    const maxDemos = Math.max(...stats.map((s) => s.demosCompleted));
    if (maxDemos >= 3) {
      stats.filter((s) => s.demosCompleted === maxDemos).forEach((s) => s.badges.push('Hot Streak'));
    }
  }

  // Default sort by deals closed
  stats.sort((a, b) => b.dealsClosed - a.dealsClosed);

  // Status sentence — calm fact about the team, narrated by Cola.
  const ranked = stats.length;
  const closed = stats.reduce((sum, s) => sum + s.dealsClosed, 0);
  const statusSentence = (() => {
    if (ranked === 0) return 'No sellers to rank yet.';
    if (closed === 0) return `Ranking ${ranked} ${ranked === 1 ? 'seller' : 'sellers'} — no deals closed yet.`;
    return `Ranking ${ranked} ${ranked === 1 ? 'seller' : 'sellers'} · ${closed} ${closed === 1 ? 'deal' : 'deals'} closed.`;
  })();

  return (
    <div className="space-y-8 max-w-5xl mx-auto pb-56 md:pb-24">
      <header className="space-y-1.5">
        <h1 className={cn(H1)} style={TITLE_FONT}>
          Leaderboard
        </h1>
        <p className={cn(BODY_MUTED)}>{statusSentence}</p>
      </header>
      <LeaderboardClient initialStats={stats} />
    </div>
  );
}
