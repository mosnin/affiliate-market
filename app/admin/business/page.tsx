import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { TrendingUp, Users, ShoppingBag, Coins, AlertTriangle, Hourglass } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  H1,
  H2,
  BODY_MUTED,
  SECTION_LABEL,
  STAT_NUMBER_COMPACT,
  PAGE_RHYTHM,
  SECTION_RHYTHM,
  CARD,
  STAT_CARD,
  ICON_SQUARE,
  CHIP_NEUTRAL,
  CHIP_NEGATIVE,
  CHIP_POSITIVE,
  META,
} from '@/lib/typography';
import { formatCurrency } from '@/lib/formatting';
import { isPlatformAdmin } from '@/lib/permissions';
import {
  getMrrCents,
  getSubscriptionBreakdown,
  getGmvCents,
  getPlatformRevenueCents,
  getChurnSignals,
} from '@/lib/admin-metrics';

export const dynamic = 'force-dynamic';

/**
 * The operator's business view: MRR, active subscriptions, marketplace GMV,
 * and the platform's own take. Every number is a live aggregation from
 * lib/admin-metrics — no caches, no estimates. Creator-facing pages show net;
 * this is operator-facing, so the take rate and fees are gross platform
 * economics by design.
 */
export default async function BusinessPage() {
  const { userId } = await auth();
  if (!userId || !(await isPlatformAdmin())) redirect('/');

  const [mrr, breakdown, gmv30d, revenue, churn] = await Promise.all([
    getMrrCents(),
    getSubscriptionBreakdown(),
    getGmvCents('30d'),
    getPlatformRevenueCents(),
    getChurnSignals(),
  ]);

  // Take rate = what the platform keeps as a share of what flows through it.
  // Denominator is 30-day GMV (the marketplace flow the platform sits on);
  // numerator is total platform revenue (affiliate fees + any GMV fee).
  const takeRatePct =
    gmv30d.gmvCents > 0
      ? (revenue.totalCents / gmv30d.gmvCents) * 100
      : null;

  const stats = [
    { label: 'MRR', value: formatCurrency(mrr.mrrCents / 100), icon: TrendingUp },
    {
      label: 'Active subscriptions',
      value: mrr.activeSubscriptions.toLocaleString('en-US'),
      icon: Users,
    },
    { label: 'GMV · 30d', value: formatCurrency(gmv30d.gmvCents / 100), icon: ShoppingBag },
    { label: 'Platform revenue', value: formatCurrency(revenue.totalCents / 100), icon: Coins },
  ];

  // Only show tiers that have at least one live subscriber, so the table reads
  // the truth of the business rather than a fixed price sheet.
  const liveTiers = breakdown.tiers.filter((t) => t.count > 0);
  const noSubscriptions = mrr.activeSubscriptions === 0;

  return (
    <div className={cn('max-w-5xl mx-auto px-4 sm:px-6 py-10', PAGE_RHYTHM)}>
      <header className="space-y-1">
        <p className={cn(SECTION_LABEL)}>Admin</p>
        <h1 className={cn(H1)}>Business</h1>
        <p className={cn(BODY_MUTED)}>The numbers that matter.</p>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(({ label, value, icon: Icon }) => (
          <div key={label} className={cn(STAT_CARD)}>
            <div className={cn(ICON_SQUARE)}>
              <Icon size={16} aria-hidden />
            </div>
            <p className={cn(SECTION_LABEL)}>{label}</p>
            <p className={cn(STAT_NUMBER_COMPACT)}>{value}</p>
          </div>
        ))}
      </section>

      <section className={cn(SECTION_RHYTHM)}>
        <h2 className={cn(H2)}>Subscriptions</h2>
        {noSubscriptions ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-5 py-10 text-center">
            <p className={cn(BODY_MUTED)}>No paid subscriptions yet.</p>
          </div>
        ) : (
          <div className={cn(CARD, 'overflow-hidden')}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/40">
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Tier</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium')}>
                    Subscribers
                  </th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium')}>MRR</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {liveTiers.map((row) => (
                  <tr key={row.tier} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-foreground">{row.label}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.count.toLocaleString('en-US')}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {formatCurrency(row.mrrCents / 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border/60 bg-muted/40">
                  <td className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Total</td>
                  <td className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium tabular-nums')}>
                    {mrr.activeSubscriptions.toLocaleString('en-US')}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-foreground">
                    {formatCurrency(mrr.mrrCents / 100)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <section className={cn(SECTION_RHYTHM)}>
        <h2 className={cn(H2)}>Health</h2>
        <div className={cn(CARD, 'px-5 py-5 space-y-4')}>
          <div className="flex flex-wrap items-center gap-2">
            {churn.atRiskCount > 0 ? (
              <span className={cn(CHIP_NEGATIVE)}>
                <AlertTriangle size={12} className="mr-1" aria-hidden />
                {churn.atRiskCount} at-risk / churned
              </span>
            ) : (
              <span className={cn(CHIP_POSITIVE)}>No at-risk subscriptions</span>
            )}
            {churn.trialingCount > 0 && (
              <span className={cn(CHIP_NEUTRAL)}>
                <Hourglass size={12} className="mr-1" aria-hidden />
                {churn.trialingCount} trialing
              </span>
            )}
          </div>
          {churn.atRiskCount > 0 && (
            <p className={cn(META)}>
              {churn.pastDueCount} past due · {churn.canceledCount} canceled ·{' '}
              {churn.unpaidCount} unpaid
            </p>
          )}
        </div>
      </section>

      <section className={cn(SECTION_RHYTHM)}>
        <h2 className={cn(H2)}>Take rate</h2>
        <div className={cn(CARD, 'px-5 py-5 flex flex-wrap items-baseline justify-between gap-3')}>
          <div className="space-y-1">
            <p className={cn(SECTION_LABEL)}>Platform revenue ÷ GMV (30d)</p>
            <p className={cn(BODY_MUTED)}>
              {formatCurrency(revenue.totalCents / 100)} kept on{' '}
              {formatCurrency(gmv30d.gmvCents / 100)} of marketplace volume.
            </p>
          </div>
          <p className={cn(STAT_NUMBER_COMPACT)}>
            {takeRatePct === null ? '—' : `${takeRatePct.toFixed(1)}%`}
          </p>
        </div>
      </section>
    </div>
  );
}
