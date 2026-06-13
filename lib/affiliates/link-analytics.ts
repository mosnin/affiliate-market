import { supabase } from '@/lib/supabase';

/**
 * Per-link performance: clicks, customers, conversion rate, and EPC
 * (earnings per click — the number creators actually optimize on). Earnings
 * are the creator's NET (approved + paid), so EPC is what a click is worth
 * to them after the platform fee.
 *
 * Joins: Commission → referralId → Referral → linkId. Clicks → linkId.
 */

export interface LinkAnalytics {
  linkId: string;
  clicks: number;
  customers: number;
  /** customers / clicks, 0–1. */
  conversionRate: number;
  /** Net earned cents attributed to this link. */
  earnedNetCents: number;
  /** earnedNetCents / clicks, in cents. */
  epcCents: number;
}

export async function getLinkAnalyticsForPartners(
  partnerIds: string[],
): Promise<Map<string, LinkAnalytics>> {
  const out = new Map<string, LinkAnalytics>();
  if (partnerIds.length === 0) return out;

  const { data: links } = await supabase
    .from('ReferralLink')
    .select('id')
    .in('partnerId', partnerIds);
  const linkIds = (links ?? []).map((l) => l.id);
  if (linkIds.length === 0) return out;

  const [clicksRes, referralsRes] = await Promise.all([
    supabase.from('ReferralClick').select('linkId').in('linkId', linkIds),
    supabase.from('Referral').select('id, linkId, status').in('linkId', linkIds),
  ]);

  const clicksByLink = new Map<string, number>();
  for (const c of clicksRes.data ?? []) {
    clicksByLink.set(c.linkId, (clicksByLink.get(c.linkId) ?? 0) + 1);
  }

  const referrals = referralsRes.data ?? [];
  const linkByReferral = new Map(referrals.map((r) => [r.id, r.linkId]));
  const customersByLink = new Map<string, number>();
  for (const r of referrals) {
    if (r.status === 'customer') {
      customersByLink.set(r.linkId, (customersByLink.get(r.linkId) ?? 0) + 1);
    }
  }

  // Net earnings per link, via the referral that produced each commission.
  const earnedByLink = new Map<string, number>();
  const referralIds = referrals.map((r) => r.id);
  if (referralIds.length > 0) {
    const { data: commissions } = await supabase
      .from('AffiliateCommission')
      .select('referralId, netCents, amountCents, status')
      .in('referralId', referralIds)
      .in('status', ['approved', 'paid']);
    for (const c of commissions ?? []) {
      const linkId = c.referralId ? linkByReferral.get(c.referralId) : null;
      if (linkId) {
        earnedByLink.set(linkId, (earnedByLink.get(linkId) ?? 0) + (c.netCents ?? c.amountCents ?? 0));
      }
    }
  }

  for (const linkId of linkIds) {
    const clicks = clicksByLink.get(linkId) ?? 0;
    const customers = customersByLink.get(linkId) ?? 0;
    const earnedNetCents = earnedByLink.get(linkId) ?? 0;
    out.set(linkId, {
      linkId,
      clicks,
      customers,
      conversionRate: clicks > 0 ? customers / clicks : 0,
      earnedNetCents,
      epcCents: clicks > 0 ? Math.round(earnedNetCents / clicks) : 0,
    });
  }
  return out;
}

export function formatConversionRate(rate: number): string {
  return `${(rate * 100).toFixed(rate >= 0.1 ? 0 : 1)}%`;
}
