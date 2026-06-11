import { redirect } from 'next/navigation';
import { auth, currentUser } from '@clerk/nextjs/server';
import Link from 'next/link';
import { SignInButton } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import {
  H1,
  H2,
  H3,
  BODY_MUTED,
  SECTION_LABEL,
  STAT_NUMBER_COMPACT,
  PRIMARY_PILL,
  GHOST_PILL,
  PAGE_RHYTHM,
  SECTION_RHYTHM,
  FIELD_RHYTHM,
  META,
  CAPTION,
  TITLE_FONT,
} from '@/lib/typography';
import { formatCurrency } from '@/lib/formatting';
import { getPartnerByUser } from '@/lib/affiliates/partners';
import { listLinksForPartner, buildReferralUrl } from '@/lib/affiliates/links';
import { getAffiliateStats } from '@/lib/affiliates/stats';
import { listCommissionsForPartner } from '@/lib/affiliates/commissions';
import { getPayableBalanceCents } from '@/lib/affiliates/payouts';
import { CopyLinkButton } from '@/components/affiliate/copy-link-button';
import { NewLinkButton } from '@/components/affiliate/new-link-button';

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200/70',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200/70',
  paid: 'bg-blue-50 text-blue-700 border-blue-200/70',
  rejected: 'bg-red-50 text-red-700 border-red-200/70',
};

export default async function AffiliateDashboardPage() {
  const { userId } = await auth();

  if (!userId) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-20 text-center space-y-4">
        <h1 className={cn(H1)} style={TITLE_FONT}>
          Affiliate dashboard.
        </h1>
        <p className={cn(BODY_MUTED)}>Sign in to view your affiliate dashboard.</p>
        <SignInButton mode="modal">
          <button className={cn(PRIMARY_PILL, 'mt-2')}>Sign in</button>
        </SignInButton>
      </div>
    );
  }

  const clerkUser = await currentUser();
  const email = clerkUser?.emailAddresses?.[0]?.emailAddress ?? null;

  const partner = await getPartnerByUser({ clerkUserId: userId, email });

  if (!partner) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-20 text-center space-y-4">
        <h1 className={cn(H1)} style={TITLE_FONT}>
          No affiliate account found.
        </h1>
        <p className={cn(BODY_MUTED)}>
          You haven&apos;t applied to any affiliate program yet.
        </p>
        <Link href="/affiliate" className={cn(PRIMARY_PILL, 'mt-2 inline-flex')}>
          Apply to a program
        </Link>
      </div>
    );
  }

  if (partner.status === 'pending') {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-20 text-center space-y-4">
        <div className="w-12 h-12 rounded-full bg-amber-50 border border-amber-200/70 flex items-center justify-center mx-auto">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="text-amber-600">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </div>
        <h1 className={cn(H1)} style={TITLE_FONT}>
          Application under review.
        </h1>
        <p className={cn(BODY_MUTED)}>
          Your application is being reviewed. We&apos;ll email you at{' '}
          <span className="text-foreground">{partner.email}</span> once approved.
          Most applications are reviewed within one business day.
        </p>
      </div>
    );
  }

  if (partner.status === 'suspended') {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-20 text-center space-y-4">
        <h1 className={cn(H1)} style={TITLE_FONT}>
          Account suspended.
        </h1>
        <p className={cn(BODY_MUTED)}>
          Your affiliate account has been suspended. Contact support for more information.
        </p>
      </div>
    );
  }

  // approved partner — load all data
  const [stats, links, commissions, payableCents] = await Promise.all([
    getAffiliateStats(partner.id),
    listLinksForPartner(partner.id),
    listCommissionsForPartner(partner.id, 10),
    getPayableBalanceCents(partner.id),
  ]);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';

  return (
    <div className={cn('max-w-4xl mx-auto px-4 sm:px-6 py-10', PAGE_RHYTHM)}>
      {/* Header */}
      <header className="space-y-1">
        <p className={cn(SECTION_LABEL)}>Affiliate dashboard</p>
        <h1 className={cn(H1)} style={TITLE_FONT}>
          {partner.name}
        </h1>
      </header>

      {/* Stat grid */}
      <section>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded-xl overflow-hidden border border-border/60 bg-border/60">
          {[
            { label: 'Clicks', value: stats.clicks.toLocaleString() },
            { label: 'Customers', value: stats.customers.toLocaleString() },
            { label: 'Pending', value: formatCurrency(stats.pendingCents / 100) },
            { label: 'Paid', value: formatCurrency(stats.paidCents / 100) },
          ].map(({ label, value }) => (
            <div key={label} className="bg-background px-4 py-4 space-y-1.5">
              <p className={cn(SECTION_LABEL)}>{label}</p>
              <p className={cn(STAT_NUMBER_COMPACT)}>{value}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Payable balance callout */}
      {payableCents > 0 && (
        <div className="rounded-xl border border-border/60 bg-muted/20 px-5 py-4 flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <p className={cn(SECTION_LABEL)}>ready to pay out</p>
            <p className={cn(STAT_NUMBER_COMPACT)}>{formatCurrency(payableCents / 100)}</p>
          </div>
          <Link href="/affiliate/payouts" className={cn(GHOST_PILL, 'text-xs shrink-0')}>
            View payouts
          </Link>
        </div>
      )}

      {/* Links section */}
      <section className={cn(SECTION_RHYTHM)}>
        <div className="flex items-center justify-between gap-4">
          <h2 className={cn(H2)}>Referral links</h2>
          <NewLinkButton />
        </div>

        {links.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-5 py-10 text-center">
            <p className={cn(BODY_MUTED)}>No referral links yet. Create one to get started.</p>
          </div>
        ) : (
          <div className={cn(FIELD_RHYTHM)}>
            {links.map((link) => {
              const url = buildReferralUrl(link.code, appUrl);
              return (
                <div
                  key={link.id}
                  className="rounded-xl border border-border/60 bg-background px-4 py-3 flex items-center gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate font-mono">{url}</p>
                    <p className={cn(META, 'mt-0.5')}>
                      {link.clicks} {link.clicks === 1 ? 'click' : 'clicks'}
                    </p>
                  </div>
                  <CopyLinkButton url={url} />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Recent commissions */}
      <section className={cn(SECTION_RHYTHM)}>
        <h2 className={cn(H2)}>Recent commissions</h2>

        {commissions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-5 py-10 text-center">
            <p className={cn(BODY_MUTED)}>No commissions yet. Share your referral link to start earning.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border/60 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/30">
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Date</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Order</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium')}>Amount</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {commissions.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/10 transition-colors">
                    <td className={cn(META, 'px-4 py-3 align-middle')}>
                      {new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className={cn(CAPTION, 'px-4 py-3 align-middle font-mono')}>
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
