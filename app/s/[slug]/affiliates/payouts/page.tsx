import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import {
  H1,
  H2,
  BODY_MUTED,
  SECTION_LABEL,
  PAGE_RHYTHM,
  SECTION_RHYTHM,
  META,
  CAPTION,
  TITLE_FONT,
} from '@/lib/typography';
import { formatCurrency } from '@/lib/formatting';
import { getSpaceFromSlug, getSpaceForUser } from '@/lib/space';
import { listPayouts } from '@/lib/affiliates/payouts';
import { RunPayoutButton } from '@/components/affiliate/run-payout-button';

const AFFILIATE_TABS = [
  { label: 'Overview', href: '' },
  { label: 'Program', href: '/program' },
  { label: 'Commissions', href: '/commissions' },
  { label: 'Payouts', href: '/payouts' },
];

const PAYOUT_STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200/70',
  processing: 'bg-blue-50 text-blue-700 border-blue-200/70',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200/70',
  failed: 'bg-red-50 text-red-700 border-red-200/70',
};

export default async function AffiliatePayoutsAdminPage({
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

  const payouts = await listPayouts(space.id);

  return (
    <div className={cn(PAGE_RHYTHM)}>
      {/* Page header */}
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className={cn(SECTION_LABEL)}>Affiliates</p>
          <h1 className={cn(H1)} style={TITLE_FONT}>
            Payouts
          </h1>
        </div>
        <RunPayoutButton />
      </header>

      {/* Tab strip */}
      <nav className="flex items-center gap-0.5 border-b border-border/60 -mb-6">
        {AFFILIATE_TABS.map(({ label, href }) => {
          const isActive = href === '/payouts';
          return (
            <Link
              key={label}
              href={`/s/${slug}/affiliates${href}`}
              className={cn(
                'px-3.5 h-9 inline-flex items-center text-sm transition-colors border-b-2 -mb-px',
                isActive
                  ? 'border-foreground text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Payout history */}
      <section className={cn(SECTION_RHYTHM)}>
        <h2 className={cn(H2)}>Payout history</h2>

        {payouts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-5 py-10 text-center">
            <p className={cn(BODY_MUTED)}>
              No payouts yet. Run a payout batch to pay out all partners with approved commissions.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-border/60 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/30">
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Date</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium hidden sm:table-cell')}>Partner</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium')}>Amount</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium hidden md:table-cell')}>Method</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {payouts.map((p) => (
                  <tr key={p.id} className="hover:bg-muted/10 transition-colors">
                    <td className={cn(META, 'px-4 py-3 align-middle')}>
                      {new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className={cn('px-4 py-3 align-middle hidden sm:table-cell')}>
                      <p className="text-sm text-foreground font-medium">{p.partnerName}</p>
                      <p className={cn(CAPTION)}>{p.partnerEmail}</p>
                    </td>
                    <td className={cn('px-4 py-3 align-middle text-right text-sm font-medium tabular-nums text-foreground')}>
                      {formatCurrency(p.amountCents / 100)}
                    </td>
                    <td className={cn(CAPTION, 'px-4 py-3 align-middle hidden md:table-cell')}>
                      {p.method ?? '—'}
                    </td>
                    <td className="px-4 py-3 align-middle">
                      <span className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border',
                        PAYOUT_STATUS_BADGE[p.status] ?? 'bg-muted text-muted-foreground border-border/60',
                      )}>
                        {p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
