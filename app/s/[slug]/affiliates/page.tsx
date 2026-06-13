import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Users2, MousePointerClick, ShoppingCart, Clock } from 'lucide-react';
import {
  H1,
  H2,
  BODY_MUTED,
  SECTION_LABEL,
  STAT_NUMBER_COMPACT,
  PAGE_RHYTHM,
  SECTION_RHYTHM,
  FIELD_RHYTHM,
  META,
  CAPTION,
  STAT_CARD,
  ICON_SQUARE,
  CHIP_POSITIVE,
  CHIP_NEUTRAL,
  CHIP_NEGATIVE,
} from '@/lib/typography';
import { formatCurrency } from '@/lib/formatting';
import { getSpaceFromSlug, getSpaceForUser } from '@/lib/space';
import { getProgramStats } from '@/lib/affiliates/stats';
import { listPartners } from '@/lib/affiliates/partners';
import { PartnerActions } from '@/components/affiliate/partner-actions';
import { CopyUrlButton } from '@/components/affiliate/copy-url-button';

const AFFILIATE_TABS = [
  { label: 'Overview', href: '' },
  { label: 'Program', href: '/program' },
  { label: 'Creators', href: '/creators' },
  { label: 'Commissions', href: '/commissions' },
  { label: 'Payouts', href: '/payouts' },
];

export default async function AffiliatesOverviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  const userSpace = await getSpaceForUser(userId);
  if (!userSpace || userSpace.id !== space.id) notFound();

  const [programStats, partners] = await Promise.all([
    getProgramStats(space.id),
    listPartners(space.id),
  ]);

  const pending = partners.filter((p) => p.status === 'pending');
  // Leaderboard order: best earners first, so the seller sees who's driving sales.
  const rest = partners
    .filter((p) => p.status !== 'pending')
    .sort((a, b) => b.earnedCents - a.earnedCents || b.customers - a.customers);
  const joinUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/affiliate`;

  return (
    <div className={cn(PAGE_RHYTHM)}>
      {/* Page header */}
      <header className="space-y-1">
        <p className={cn(SECTION_LABEL)}>Affiliates</p>
        <h1 className={cn(H1)}>
          Affiliate program
        </h1>
      </header>

      {/* Tab strip */}
      <nav className="flex items-center gap-0.5 border-b border-border/60 -mb-6">
        {AFFILIATE_TABS.map(({ label, href }) => {
          const isActive = href === '';
          return (
            <Link
              key={label}
              href={`/s/${slug}/affiliates${href}`}
              className={cn(
                'px-3.5 h-9 inline-flex items-center text-sm transition-colors border-b-2 -mb-px',
                isActive
                  ? 'border-primary text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Program stats */}
      <section>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Partners', value: programStats.partners.toLocaleString(), Icon: Users2 },
            { label: 'Clicks', value: programStats.clicks.toLocaleString(), Icon: MousePointerClick },
            { label: 'Customers', value: programStats.customers.toLocaleString(), Icon: ShoppingCart },
            { label: 'Pending approval', value: formatCurrency(programStats.pendingCommissionsCents / 100), Icon: Clock },
          ].map(({ label, value, Icon }) => (
            <div key={label} className={cn(STAT_CARD)}>
              <div className={cn(ICON_SQUARE)}>
                <Icon size={16} strokeWidth={1.75} />
              </div>
              <p className={cn(SECTION_LABEL)}>{label}</p>
              <p className={cn(STAT_NUMBER_COMPACT)}>{value}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Partners table */}
      <section className={cn(SECTION_RHYTHM)}>
        <div className="flex items-center justify-between gap-4">
          <h2 className={cn(H2)}>Partners</h2>
          {programStats.pendingPartners > 0 && (
            <span className={cn(CHIP_NEUTRAL)}>
              {programStats.pendingPartners} pending
            </span>
          )}
        </div>

        {partners.length === 0 ? (
          <div className="rounded-2xl border border-border bg-muted/20 px-5 py-10 text-center space-y-3">
            <p className={cn(BODY_MUTED)}>No affiliates yet. Share your join page to get started.</p>
            <div className="flex items-center justify-center gap-2">
              <span className="text-xs text-muted-foreground font-mono bg-muted/40 px-2 py-1 rounded">
                {joinUrl}
              </span>
              <CopyUrlButton url={joinUrl} />
            </div>
          </div>
        ) : (
          <div className={cn(FIELD_RHYTHM)}>
            {/* Pending partners surfaced first */}
            {pending.length > 0 && (
              <div className="space-y-2">
                <p className={cn(SECTION_LABEL)}>pending approval</p>
                <div className="rounded-2xl border border-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/60 bg-muted/40">
                        <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Name</th>
                        <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium hidden sm:table-cell')}>Email</th>
                        <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium hidden md:table-cell')}>Joined</th>
                        <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium')}></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {pending.map((p) => (
                        <tr key={p.id} className="hover:bg-muted/10 transition-colors">
                          <td className={cn('px-4 py-3 align-middle text-sm font-medium text-foreground')}>
                            {p.name}
                          </td>
                          <td className={cn(CAPTION, 'px-4 py-3 align-middle hidden sm:table-cell')}>
                            {p.email}
                          </td>
                          <td className={cn(META, 'px-4 py-3 align-middle hidden md:table-cell')}>
                            {new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </td>
                          <td className="px-4 py-3 align-middle text-right">
                            <PartnerActions partnerId={p.id} status={p.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* All partners */}
            {rest.length > 0 && (
              <div className="rounded-2xl border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 bg-muted/40">
                      <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Name</th>
                      <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium hidden sm:table-cell')}>Email</th>
                      <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium')}>Clicks</th>
                      <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium hidden md:table-cell')}>Customers</th>
                      <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium hidden md:table-cell')}>Earned</th>
                      <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Status</th>
                      <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium hidden lg:table-cell')}>Joined</th>
                      <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium')}></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {rest.map((p) => (
                      <tr key={p.id} className="hover:bg-muted/10 transition-colors">
                        <td className={cn('px-4 py-3 align-middle text-sm font-medium text-foreground')}>
                          {p.name}
                        </td>
                        <td className={cn(CAPTION, 'px-4 py-3 align-middle hidden sm:table-cell')}>
                          {p.email}
                        </td>
                        <td className={cn('px-4 py-3 align-middle text-right tabular-nums text-sm text-muted-foreground')}>
                          {p.clicks}
                        </td>
                        <td className={cn('px-4 py-3 align-middle text-right tabular-nums text-sm text-muted-foreground hidden md:table-cell')}>
                          {p.customers}
                        </td>
                        <td className={cn('px-4 py-3 align-middle text-right tabular-nums text-sm text-foreground font-medium hidden md:table-cell')}>
                          {formatCurrency(p.earnedCents / 100)}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {p.status === 'approved' && (
                            <span className={cn(CHIP_POSITIVE)}>{p.status}</span>
                          )}
                          {p.status === 'pending' && (
                            <span className={cn(CHIP_NEUTRAL)}>{p.status}</span>
                          )}
                          {p.status === 'suspended' && (
                            <span className={cn(CHIP_NEGATIVE)}>{p.status}</span>
                          )}
                          {p.status !== 'approved' && p.status !== 'pending' && p.status !== 'suspended' && (
                            <span className={cn(CHIP_NEUTRAL)}>{p.status}</span>
                          )}
                        </td>
                        <td className={cn(META, 'px-4 py-3 align-middle hidden lg:table-cell')}>
                          {new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </td>
                        <td className="px-4 py-3 align-middle text-right">
                          <PartnerActions partnerId={p.id} status={p.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
