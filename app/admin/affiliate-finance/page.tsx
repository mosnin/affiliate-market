import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { Banknote, TrendingUp, Undo2, ReceiptText, Download } from 'lucide-react';
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
  GHOST_PILL,
  META,
} from '@/lib/typography';
import { formatCurrency } from '@/lib/formatting';
import { isPlatformAdmin } from '@/lib/permissions';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * The platform's own money view: what Cola has earned in fees, what it owes
 * creators, what sellers owe it, and what came back. Every number here is
 * a sum over the commission/payout ledgers — no derived caches to drift.
 */
export default async function AffiliateFinancePage() {
  const { userId } = await auth();
  if (!userId || !(await isPlatformAdmin())) redirect('/');

  const [commissionsRes, payoutsRes, partnersRes] = await Promise.all([
    supabase
      .from('AffiliateCommission')
      .select('spaceId, amountCents, platformFeeCents, netCents, status, source, settledAt'),
    supabase.from('AffiliatePayout').select('amountCents, status'),
    supabase.from('AffiliatePartner').select('balanceAdjustmentCents'),
  ]);

  const commissions = commissionsRes.data ?? [];
  const payouts = payoutsRes.data ?? [];

  let feesEarnedCents = 0;
  let liabilityCents = 0;
  let receivableCents = 0;
  let settledCents = 0;
  let reversedCount = 0;
  let reversedCents = 0;
  const debtBySpace = new Map<string, number>();

  for (const c of commissions) {
    const net = c.netCents ?? c.amountCents ?? 0;
    if (c.status === 'approved' || c.status === 'paid') {
      feesEarnedCents += c.platformFeeCents ?? 0;
    }
    if (c.status === 'approved') liabilityCents += net;
    if (c.status === 'reversed') {
      reversedCount += 1;
      reversedCents += net;
    }
    if (c.source === 'stripe_bridge' && c.status !== 'rejected') {
      if (c.settledAt) settledCents += c.amountCents ?? 0;
      else if (c.status !== 'reversed') {
        receivableCents += c.amountCents ?? 0;
        debtBySpace.set(c.spaceId, (debtBySpace.get(c.spaceId) ?? 0) + (c.amountCents ?? 0));
      }
    }
  }

  const clawbackCents = (partnersRes.data ?? []).reduce(
    (sum, p) => sum + Math.min(0, p.balanceAdjustmentCents ?? 0),
    0,
  );
  liabilityCents = Math.max(0, liabilityCents + clawbackCents);

  const paidOutCents = payouts
    .filter((p) => p.status === 'completed')
    .reduce((sum, p) => sum + (p.amountCents ?? 0), 0);

  const debtSpaceIds = [...debtBySpace.keys()];
  const { data: spaces } = debtSpaceIds.length
    ? await supabase.from('Space').select('id, name, slug').in('id', debtSpaceIds)
    : { data: [] as { id: string; name: string; slug: string }[] };
  const spaceById = new Map((spaces ?? []).map((s) => [s.id, s]));
  const debtRows = debtSpaceIds
    .map((id) => ({
      id,
      name: spaceById.get(id)?.name ?? id,
      slug: spaceById.get(id)?.slug ?? null,
      owedCents: debtBySpace.get(id) ?? 0,
    }))
    .sort((a, b) => b.owedCents - a.owedCents);

  const year = new Date().getFullYear();

  const stats = [
    { label: 'Platform fees earned', value: feesEarnedCents, icon: TrendingUp },
    { label: 'Owed to creators', value: liabilityCents, icon: Banknote },
    { label: 'Owed by sellers', value: receivableCents, icon: ReceiptText },
    { label: 'Paid out to date', value: paidOutCents, icon: Banknote },
  ];

  return (
    <div className={cn('max-w-5xl mx-auto px-4 sm:px-6 py-10', PAGE_RHYTHM)}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <p className={cn(SECTION_LABEL)}>Admin</p>
          <h1 className={cn(H1)}>Affiliate finance</h1>
          <p className={cn(BODY_MUTED)}>
            Fees are Cola&apos;s 20% of creator earnings. Liability is net owed to creators;
            receivable is gross owed by sellers for bridge sales.
          </p>
        </div>
        <a
          href={`/api/admin/affiliates/tax-export?year=${year}`}
          className={cn(GHOST_PILL, 'shrink-0')}
        >
          <Download size={14} aria-hidden />
          {year} tax export (CSV)
        </a>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(({ label, value, icon: Icon }) => (
          <div key={label} className={cn(STAT_CARD)}>
            <div className={cn(ICON_SQUARE)}>
              <Icon size={16} aria-hidden />
            </div>
            <p className={cn(SECTION_LABEL)}>{label}</p>
            <p className={cn(STAT_NUMBER_COMPACT)}>{formatCurrency(value / 100)}</p>
          </div>
        ))}
      </section>

      {(reversedCount > 0 || clawbackCents < 0) && (
        <section className={cn(CARD, 'px-5 py-4 flex items-center gap-3')}>
          <div className={cn(ICON_SQUARE, 'bg-negative-subtle text-negative')}>
            <Undo2 size={16} aria-hidden />
          </div>
          <p className="text-sm text-foreground">
            {reversedCount} commission{reversedCount === 1 ? '' : 's'} reversed
            ({formatCurrency(reversedCents / 100)} net)
            {clawbackCents < 0 && (
              <> · {formatCurrency(-clawbackCents / 100)} in clawback debt outstanding</>
            )}
          </p>
        </section>
      )}

      <section className={cn(SECTION_RHYTHM)}>
        <h2 className={cn(H2)}>Seller settlement debt</h2>
        {debtRows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-5 py-10 text-center">
            <p className={cn(BODY_MUTED)}>No outstanding seller debt. Settlement is current.</p>
          </div>
        ) : (
          <div className={cn(CARD, 'overflow-hidden')}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/40">
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-left font-medium')}>Seller</th>
                  <th className={cn(SECTION_LABEL, 'px-4 py-2.5 text-right font-medium')}>Owed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {debtRows.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      {row.slug ? (
                        <Link href={`/s/${row.slug}/affiliates/payouts`} className="hover:underline">
                          {row.name}
                        </Link>
                      ) : (
                        row.name
                      )}
                      <span className={cn(META, 'ml-2 text-muted-foreground')}>{row.slug}</span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {formatCurrency(row.owedCents / 100)}
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
