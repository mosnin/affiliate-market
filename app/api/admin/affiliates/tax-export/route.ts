import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/permissions';
import { supabase } from '@/lib/supabase';

/**
 * GET /api/admin/affiliates/tax-export?year=2026
 *
 * 1099 preparation: per-creator totals of NET commissions PAID in the
 * calendar year, with their Stripe Connect account id (Stripe Express
 * onboarding collects the W-9/W-8 details; this export gives the totals
 * to file against). CSV download, platform-admin only.
 */
export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const year = parseInt(req.nextUrl.searchParams.get('year') ?? '', 10) || new Date().getFullYear();
  const from = `${year}-01-01T00:00:00Z`;
  const to = `${year + 1}-01-01T00:00:00Z`;

  // Paid commissions in the year, summed per partner.
  const { data: payouts } = await supabase
    .from('AffiliatePayout')
    .select('partnerId, amountCents, paidAt, status')
    .eq('status', 'completed')
    .gte('paidAt', from)
    .lt('paidAt', to);

  const totals = new Map<string, number>();
  for (const p of payouts ?? []) {
    totals.set(p.partnerId, (totals.get(p.partnerId) ?? 0) + (p.amountCents ?? 0));
  }

  const partnerIds = [...totals.keys()];
  const { data: partners } = partnerIds.length
    ? await supabase
        .from('AffiliatePartner')
        .select('id, name, email, stripeAccountId')
        .in('id', partnerIds)
    : { data: [] as { id: string; name: string; email: string; stripeAccountId: string | null }[] };
  const byId = new Map((partners ?? []).map((p) => [p.id, p]));

  const esc = (v: string | null | undefined) => `"${(v ?? '').replace(/"/g, '""')}"`;
  const rows = [
    'name,email,stripe_account_id,paid_usd',
    ...partnerIds
      .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
      .map((id) => {
        const p = byId.get(id);
        return [
          esc(p?.name),
          esc(p?.email),
          esc(p?.stripeAccountId),
          ((totals.get(id) ?? 0) / 100).toFixed(2),
        ].join(',');
      }),
  ];

  return new NextResponse(rows.join('\n') + '\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="cola-creator-payouts-${year}.csv"`,
    },
  });
}
