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
import { listCommissions } from '@/lib/affiliates/commissions';
import { CommissionActions } from '@/components/affiliate/commission-actions';
import type { CommissionStatus } from '@/lib/affiliates/commissions';

const AFFILIATE_TABS = [
  { label: 'Overview', href: '' },
  { label: 'Program', href: '/program' },
  { label: 'Commissions', href: '/commissions' },
  { label: 'Payouts', href: '/payouts' },
];

const STATUS_FILTER_TABS: { label: string; value: string }[] = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'pending' },
  { label: 'Approved', value: 'approved' },
  { label: 'Paid', value: 'paid' },
  { label: 'Rejected', value: 'rejected' },
];

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200/70',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200/70',
  paid: 'bg-blue-50 text-blue-700 border-blue-200/70',
  rejected: 'bg-red-50 text-red-700 border-red-200/70',
};

export default async function AffiliateCommissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ slug }, { status }] = await Promise.all([params, searchParams]);

  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  const userSpace = await getSpaceForUser(userId);
  if (!userSpace || userSpace.id !== space.id) notFound();

  const activeStatus = STATUS_FILTER_TABS.some((t) => t.value === status) ? status : '';
  const commissions = await listCommissions(space.id, activeStatus ? { status: activeStatus } : undefined);

  return (
    <div className={cn(PAGE_RHYTHM)}>
      {/* Page header */}
      <header className="space-y-1">
        <p className={cn(SECTION_LABEL)}>Affiliates</p>
        <h1 className={cn(H1)} style={TITLE_FONT}>
          Commissions
        </h1>
      </header>

      {/* Tab strip */}
      <nav className="flex items-center gap-0.5 border-b border-border/60 -mb-6">
        {AFFILIATE_TABS.map(({ label, href }) => {
          const isActive = href === '/commissions';
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

      {/* Status filter tabs */}
      <section className={cn(SECTION_RHYTHM)}>
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTER_TABS.map(({ label, value }) => {
            const isActive = activeStatus === value;
            const href = value
              ? `/s/${slug}/affiliates/commissions?status=${value}`
              : `/s/${slug}/affiliates/commissions`;
            return (
              <Link
                key={value}
                href={href}
                className={cn(
                  'px-3 h-8 inline-flex items-center rounded-full text-xs font-medium transition-colors border',
                  isActive
                    ? 'bg-foreground text-background border-foreground'
                    : 'bg-background text-muted-foreground border-border/60 hover:text-foreground hover:border-foreground/30',
                )}
              >
                {label}
              </Link>
            );
          })}
        </div>

        <h2 className={cn(H2)}>
          {activeStatus ? `${activeStatus.charAt(0).toUpperCase()}${activeStatus.slice(1)}` : 'All'} commissions
        </h2>

        {commissions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-5 py-10 text-center">
            <p className={cn(BODY_MUTED)}>
              {activeStatus
                ? `No ${activeStatus} commissions.`
                : 'No commissions yet. Commissions are created when referred customers make a purchase.'}
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-border/60 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/30">
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Date</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium hidden sm:table-cell')}>Partner</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium hidden md:table-cell')}>Order</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium')}>Amount</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Status</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium')}></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {commissions.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/10 transition-colors">
                    <td className={cn(META, 'px-4 py-3 align-middle')}>
                      {new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className={cn('px-4 py-3 align-middle hidden sm:table-cell')}>
                      <p className="text-sm text-foreground font-medium">{c.partnerName}</p>
                      <p className={cn(CAPTION)}>{c.partnerEmail}</p>
                    </td>
                    <td className={cn(CAPTION, 'px-4 py-3 align-middle font-mono hidden md:table-cell')}>
                      {c.orderId ? c.orderId.slice(0, 8) + '…' : '—'}
                    </td>
                    <td className={cn('px-4 py-3 align-middle text-right text-sm font-medium tabular-nums text-foreground')}>
                      {formatCurrency(c.amountCents / 100)}
                    </td>
                    <td className="px-4 py-3 align-middle">
                      <span className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border',
                        STATUS_BADGE[c.status] ?? 'bg-muted text-muted-foreground border-border/60',
                      )}>
                        {c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-middle text-right">
                      {c.status === 'pending' && (
                        <CommissionActions commissionId={c.id} />
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
