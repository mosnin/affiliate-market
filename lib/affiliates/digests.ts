import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server'; // MarketplaceOrder reads (Convex); AffiliatePartner/Commission stay Supabase

/**
 * Weekly digest data — the last 7 days, for the cron that emails both sides.
 * Kept separate from the lifetime stats functions: digests are deltas.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function weekAgoIso(): string {
  return new Date(Date.now() - WEEK_MS).toISOString();
}

export interface CreatorWeekly {
  clicks: number;
  customers: number;
  earnedNetCents: number;
}

/** A creator's last-7-days, aggregated across all their partner rows. */
export async function getCreatorWeekly(partnerIds: string[]): Promise<CreatorWeekly> {
  if (partnerIds.length === 0) return { clicks: 0, customers: 0, earnedNetCents: 0 };
  const since = weekAgoIso();

  const { data: links } = await supabase.from('ReferralLink').select('id').in('partnerId', partnerIds);
  const linkIds = (links ?? []).map((l) => l.id);

  const [clicksRes, referralsRes, commissionsRes] = await Promise.all([
    linkIds.length
      ? supabase.from('ReferralClick').select('id', { count: 'exact', head: true }).in('linkId', linkIds).gte('createdAt', since)
      : Promise.resolve({ count: 0 } as { count: number | null }),
    supabase.from('Referral').select('id', { count: 'exact', head: true }).in('partnerId', partnerIds).eq('status', 'customer').gte('convertedAt', since),
    supabase.from('AffiliateCommission').select('netCents, amountCents, status').in('partnerId', partnerIds).gte('createdAt', since).in('status', ['approved', 'paid']),
  ]);

  const earnedNetCents = (commissionsRes.data ?? []).reduce((s, c) => s + (c.netCents ?? c.amountCents ?? 0), 0);
  return {
    clicks: clicksRes.count ?? 0,
    customers: referralsRes.count ?? 0,
    earnedNetCents,
  };
}

export interface SellerWeekly {
  sales: number;
  revenueCents: number;
  newPartners: number;
  pendingPartners: number;
}

/** A seller's last-7-days program activity. */
export async function getSellerWeekly(spaceId: string): Promise<SellerWeekly> {
  const since = weekAgoIso();
  // MarketplaceOrder is on Convex; AffiliatePartner stays on Supabase (hybrid).
  const [amounts, newPartnersRes, pendingRes] = await Promise.all([
    convex().query(api.marketplace.orders.paidAmountsForSpaceSince, {
      spaceId,
      since,
    }) as Promise<number[]>,
    supabase.from('AffiliatePartner').select('id', { count: 'exact', head: true }).eq('spaceId', spaceId).gte('createdAt', since),
    supabase.from('AffiliatePartner').select('id', { count: 'exact', head: true }).eq('spaceId', spaceId).eq('status', 'pending'),
  ]);
  return {
    sales: amounts.length,
    revenueCents: amounts.reduce((s, c) => s + (c ?? 0), 0),
    newPartners: newPartnersRes.count ?? 0,
    pendingPartners: pendingRes.count ?? 0,
  };
}

/** Distinct spaces with any program activity (orders/partners/commissions) in the window. */
export async function listActiveSpacesForDigest(): Promise<string[]> {
  const since = weekAgoIso();
  // MarketplaceOrder is on Convex; AffiliatePartner/AffiliateCommission stay on
  // Supabase (hybrid).
  const [orderRows, partners, commissions] = await Promise.all([
    convex().query(api.marketplace.orders.ordersForMetrics, { createdSince: since }) as Promise<
      Array<{ spaceId: string }>
    >,
    supabase.from('AffiliatePartner').select('spaceId').gte('createdAt', since),
    supabase.from('AffiliateCommission').select('spaceId').gte('createdAt', since),
  ]);
  const ids = new Set<string>();
  for (const r of orderRows) ids.add(r.spaceId);
  for (const r of partners.data ?? []) ids.add(r.spaceId);
  for (const r of commissions.data ?? []) ids.add(r.spaceId);
  return [...ids];
}
