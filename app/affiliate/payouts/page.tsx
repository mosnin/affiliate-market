import { redirect } from 'next/navigation';
import { auth, currentUser } from '@clerk/nextjs/server';
import Link from 'next/link';
import { SignInButton } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import {
  H1,
  H2,
  BODY_MUTED,
  SECTION_LABEL,
  STAT_NUMBER_COMPACT,
  PRIMARY_PILL,
  PAGE_RHYTHM,
  SECTION_RHYTHM,
  META,
  CAPTION,
  TITLE_FONT,
} from '@/lib/typography';
import { formatCurrency } from '@/lib/formatting';
import { getPartnerByUser } from '@/lib/affiliates/partners';
import { listPayoutsForPartner, getPayableBalanceCents } from '@/lib/affiliates/payouts';

const PAYOUT_STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200/70',
  processing: 'bg-blue-50 text-blue-700 border-blue-200/70',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200/70',
  failed: 'bg-red-50 text-red-700 border-red-200/70',
};

export default async function AffiliatePayoutsPage() {
  const { userId } = await auth();

  if (!userId) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-20 text-center space-y-4">
        <h1 className={cn(H1)} style={TITLE_FONT}>
          Payouts.
        </h1>
        <p className={cn(BODY_MUTED)}>Sign in to view your payouts.</p>
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
          No affiliate account.
        </h1>
        <p className={cn(BODY_MUTED)}>You need to join an affiliate program first.</p>
        <Link href="/affiliate" className={cn(PRIMARY_PILL, 'mt-2 inline-flex')}>
          Apply to a program
        </Link>
      </div>
    );
  }

  if (partner.status !== 'approved') {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-20 text-center space-y-4">
        <h1 className={cn(H1)} style={TITLE_FONT}>
          Not yet approved.
        </h1>
        <p className={cn(BODY_MUTED)}>
          Your affiliate account must be approved before you can receive payouts.
        </p>
      </div>
    );
  }

  const [payouts, payableCents] = await Promise.all([
    listPayoutsForPartner(partner.id),
    getPayableBalanceCents(partner.id),
  ]);

  return (
    <div className={cn('max-w-4xl mx-auto px-4 sm:px-6 py-10', PAGE_RHYTHM)}>
      {/* Header */}
      <header className="space-y-1">
        <p className={cn(SECTION_LABEL)}>Affiliate payouts</p>
        <h1 className={cn(H1)} style={TITLE_FONT}>
          Payouts
        </h1>
      </header>

      {/* Payable balance stat */}
      <section>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-px rounded-xl overflow-hidden border border-border/60 bg-border/60">
          {[
            { label: 'Available balance', value: formatCurrency(payableCents / 100) },
            { label: 'Total paid out', value: formatCurrency(payouts.reduce((s, p) => s + (p.status === 'completed' ? p.amountCents : 0), 0) / 100) },
            { label: 'Payouts', value: payouts.length.toLocaleString() },
          ].map(({ label, value }) => (
            <div key={label} className="bg-background px-4 py-4 space-y-1.5">
              <p className={cn(SECTION_LABEL)}>{label}</p>
              <p className={cn(STAT_NUMBER_COMPACT)}>{value}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Payout history */}
      <section className={cn(SECTION_RHYTHM)}>
        <h2 className={cn(H2)}>Payout history</h2>

        {payouts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-5 py-10 text-center">
            <p className={cn(BODY_MUTED)}>
              No payouts yet. Once your commissions are approved, payouts will appear here.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-border/60 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/30">
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Date</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium')}>Amount</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Method</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {payouts.map((p) => (
                  <tr key={p.id} className="hover:bg-muted/10 transition-colors">
                    <td className={cn(META, 'px-4 py-3 align-middle')}>
                      {new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className={cn('px-4 py-3 align-middle text-right text-sm font-medium tabular-nums text-foreground')}>
                      {formatCurrency(p.amountCents / 100)}
                    </td>
                    <td className={cn(CAPTION, 'px-4 py-3 align-middle')}>
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
