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
  CHIP_POSITIVE,
  CHIP_NEUTRAL,
  CHIP_NEGATIVE,
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
          <h1 className={cn(H1)}>
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
                  ? 'border-primary text-foreground font-medium'
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
          <div className="rounded-2xl border border-border bg-muted/20 px-5 py-10 text-center">
            <p className={cn(BODY_MUTED)}>
              No payouts yet. Run a payout batch to pay out all partners with approved commissions.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/40">
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
                      {p.status === 'completed' && (
                        <span className={cn(CHIP_POSITIVE)}>{p.status}</span>
                      )}
                      {(p.status === 'pending' || p.status === 'processing') && (
                        <span className={cn(CHIP_NEUTRAL)}>{p.status}</span>
                      )}
                      {p.status === 'failed' && (
                        <span className={cn(CHIP_NEGATIVE)}>{p.status}</span>
                      )}
                      {p.status !== 'completed' && p.status !== 'pending' && p.status !== 'processing' && p.status !== 'failed' && (
                        <span className={cn(CHIP_NEUTRAL)}>{p.status}</span>
                      )}
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
