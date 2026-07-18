import { supabase } from '@/lib/supabase';

export interface AffiliateStats {
  clicks: number;
  referrals: number;
  customers: number;
  pendingCents: number;
  approvedCents: number;
  paidCents: number;
}

export interface ProgramStats {
  partners: number;
  pendingPartners: number;
  clicks: number;
  customers: number;
  pendingCommissionsCents: number;
  approvedCommissionsCents: number;
  paidOutCents: number;
}

/**
 * Lifetime stats for one partner (affiliate dashboard). Money figures are
 * the creator's NET (after the platform fee) — that's the number a creator
 * should ever see.
 */
export async function getAffiliateStats(partnerId: string): Promise<AffiliateStats> {
  return getAffiliateStatsForPartners([partnerId]);
}

/** Aggregated net stats across all of a creator's partner rows. */
export async function getAffiliateStatsForPartners(
  partnerIds: string[],
): Promise<AffiliateStats> {
  if (partnerIds.length === 0) {
    return { clicks: 0, referrals: 0, customers: 0, pendingCents: 0, approvedCents: 0, paidCents: 0 };
  }

  const { data: links } = await supabase
    .from('ReferralLink')
    .select('id')
    .in('partnerId', partnerIds);
  const linkIds = (links ?? []).map((l) => l.id);

  const [clicksRes, referralsRes, commissionsRes] = await Promise.all([
    linkIds.length > 0
      ? supabase
          .from('ReferralClick')
          .select('id', { count: 'exact', head: true })
          .in('linkId', linkIds)
      : Promise.resolve({ count: 0 } as { count: number | null }),
    supabase.from('Referral').select('status').in('partnerId', partnerIds),
    supabase
      .from('AffiliateCommission')
      .select('amountCents, netCents, status')
      .in('partnerId', partnerIds),
  ]);

  const referralRows = referralsRes.data ?? [];
  let pendingCents = 0;
  let approvedCents = 0;
  let paidCents = 0;
  for (const c of commissionsRes.data ?? []) {
    const net = c.netCents ?? c.amountCents ?? 0;
    if (c.status === 'pending') pendingCents += net;
    else if (c.status === 'approved') approvedCents += net;
    else if (c.status === 'paid') paidCents += net;
  }

  return {
    clicks: clicksRes.count ?? 0,
    referrals: referralRows.length,
    customers: referralRows.filter((r) => r.status === 'customer').length,
    pendingCents,
    approvedCents,
    paidCents,
  };
}

/** Program-wide rollup for the seller's affiliates dashboard. */
export async function getProgramStats(spaceId: string): Promise<ProgramStats> {
  const [partnersRes, commissionsRes] = await Promise.all([
    supabase.from('AffiliatePartner').select('id, status').eq('spaceId', spaceId),
    supabase.from('AffiliateCommission').select('amountCents, status').eq('spaceId', spaceId),
  ]);

  const partnerRows = partnersRes.data ?? [];
  const partnerIds = partnerRows.map((p) => p.id);

  let clicks = 0;
  let customers = 0;
  if (partnerIds.length > 0) {
    const { data: links } = await supabase
      .from('ReferralLink')
      .select('id')
      .in('partnerId', partnerIds);
    const linkIds = (links ?? []).map((l) => l.id);
    if (linkIds.length > 0) {
      const { count } = await supabase
        .from('ReferralClick')
        .select('id', { count: 'exact', head: true })
        .in('linkId', linkIds);
      clicks = count ?? 0;
    }
    const { count: customerCount } = await supabase
      .from('Referral')
      .select('id', { count: 'exact', head: true })
      .in('partnerId', partnerIds)
      .eq('status', 'customer');
    customers = customerCount ?? 0;
  }

  let pendingCommissionsCents = 0;
  let approvedCommissionsCents = 0;
  let paidOutCents = 0;
  for (const c of commissionsRes.data ?? []) {
    if (c.status === 'pending') pendingCommissionsCents += c.amountCents ?? 0;
    else if (c.status === 'approved') approvedCommissionsCents += c.amountCents ?? 0;
    else if (c.status === 'paid') paidOutCents += c.amountCents ?? 0;
  }

  return {
    partners: partnerRows.length,
    pendingPartners: partnerRows.filter((p) => p.status === 'pending').length,
    clicks,
    customers,
    pendingCommissionsCents,
    approvedCommissionsCents,
    paidOutCents,
  };
}
