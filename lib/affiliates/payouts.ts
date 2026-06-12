import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { transferPayout } from '@/lib/affiliates/stripe-connect';

export type PayoutStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface AffiliatePayoutRow {
  id: string;
  spaceId: string;
  partnerId: string;
  /** Creator NET — what actually gets transferred. */
  amountCents: number;
  /** Cola's cut accrued over this payout's commissions. */
  platformFeeCents: number;
  method: string | null;
  status: PayoutStatus;
  stripeTransferId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface PayoutWithPartner extends AffiliatePayoutRow {
  partnerName: string;
  partnerEmail: string;
}

/** Approved-but-unpaid NET balance for one partner (after platform fee). */
export async function getPayableBalanceCents(partnerId: string): Promise<number> {
  return getPayableBalanceCentsForPartners([partnerId]);
}

/** Combined approved-but-unpaid NET balance across a creator's partner rows. */
export async function getPayableBalanceCentsForPartners(
  partnerIds: string[],
): Promise<number> {
  if (partnerIds.length === 0) return 0;
  const { data } = await supabase
    .from('AffiliateCommission')
    .select('amountCents, netCents')
    .in('partnerId', partnerIds)
    .eq('status', 'approved');
  return (data ?? []).reduce((sum, c) => sum + (c.netCents ?? c.amountCents ?? 0), 0);
}

/**
 * Pay out one partner: marks every approved commission paid and records the
 * payout (creator NET; the platform fee is retained, not transferred). When
 * the creator has a connected Stripe account and Stripe is configured, the
 * transfer happens immediately and the payout completes; otherwise it stays
 * 'pending' for manual settlement. Returns null when there is nothing to pay.
 */
export async function createPayout(
  spaceId: string,
  partnerId: string,
): Promise<AffiliatePayoutRow | null> {
  const { data: commissions } = await supabase
    .from('AffiliateCommission')
    .select('id, amountCents, netCents, platformFeeCents, createdAt')
    .eq('spaceId', spaceId)
    .eq('partnerId', partnerId)
    .eq('status', 'approved');

  if (!commissions || commissions.length === 0) return null;
  const netTotal = commissions.reduce((sum, c) => sum + (c.netCents ?? c.amountCents ?? 0), 0);
  const feeTotal = commissions.reduce((sum, c) => sum + (c.platformFeeCents ?? 0), 0);
  if (netTotal <= 0) return null;

  const { data: partner } = await supabase
    .from('AffiliatePartner')
    .select('payoutMethod, stripeAccountId')
    .eq('id', partnerId)
    .maybeSingle();

  const dates = commissions.map((c) => new Date(c.createdAt).getTime());
  const { data: payout, error } = await supabase
    .from('AffiliatePayout')
    .insert({
      spaceId,
      partnerId,
      amountCents: netTotal,
      platformFeeCents: feeTotal,
      method: partner?.stripeAccountId ? 'stripe' : (partner?.payoutMethod ?? null),
      status: 'pending',
      periodStart: new Date(Math.min(...dates)).toISOString(),
      periodEnd: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error || !payout) {
    logger.warn('[affiliates] payout insert failed', { error: error?.message });
    return null;
  }

  const { error: updErr } = await supabase
    .from('AffiliateCommission')
    .update({ status: 'paid', payoutId: payout.id })
    .in('id', commissions.map((c) => c.id));
  if (updErr) {
    logger.error('[affiliates] failed to mark commissions paid after payout insert', {
      payoutId: payout.id,
      error: updErr.message,
    });
  }

  // Stripe Connect: move the money now when we can.
  const transferId = await transferPayout({
    payoutId: payout.id,
    stripeAccountId: partner?.stripeAccountId ?? null,
    amountCents: netTotal,
  });
  if (transferId) {
    const { data: completed } = await supabase
      .from('AffiliatePayout')
      .update({ status: 'completed', stripeTransferId: transferId, paidAt: new Date().toISOString() })
      .eq('id', payout.id)
      .select('*')
      .single();
    if (completed) return completed as AffiliatePayoutRow;
  }

  return payout as AffiliatePayoutRow;
}

/** Pay out every partner in a space that has an approved balance. */
export async function runPayoutBatch(spaceId: string): Promise<AffiliatePayoutRow[]> {
  const { data: rows } = await supabase
    .from('AffiliateCommission')
    .select('partnerId')
    .eq('spaceId', spaceId)
    .eq('status', 'approved');

  const partnerIds = [...new Set((rows ?? []).map((r) => r.partnerId))];
  const payouts: AffiliatePayoutRow[] = [];
  for (const partnerId of partnerIds) {
    const payout = await createPayout(spaceId, partnerId);
    if (payout) payouts.push(payout);
  }
  return payouts;
}

export async function markPayoutCompleted(payoutId: string): Promise<boolean> {
  const { error } = await supabase
    .from('AffiliatePayout')
    .update({ status: 'completed', paidAt: new Date().toISOString() })
    .eq('id', payoutId);
  return !error;
}

export async function markPayoutFailed(payoutId: string): Promise<boolean> {
  const { error } = await supabase
    .from('AffiliatePayout')
    .update({ status: 'failed' })
    .eq('id', payoutId);
  return !error;
}

export async function listPayouts(spaceId: string): Promise<PayoutWithPartner[]> {
  const { data: payouts } = await supabase
    .from('AffiliatePayout')
    .select('*')
    .eq('spaceId', spaceId)
    .order('createdAt', { ascending: false })
    .limit(100);
  if (!payouts || payouts.length === 0) return [];

  const partnerIds = [...new Set(payouts.map((p) => p.partnerId))];
  const { data: partners } = await supabase
    .from('AffiliatePartner')
    .select('id, name, email')
    .in('id', partnerIds);
  const byId = new Map((partners ?? []).map((p) => [p.id, p]));

  return payouts.map((p) => ({
    ...(p as AffiliatePayoutRow),
    partnerName: byId.get(p.partnerId)?.name ?? 'Unknown',
    partnerEmail: byId.get(p.partnerId)?.email ?? '',
  }));
}

export async function listPayoutsForPartner(partnerId: string): Promise<AffiliatePayoutRow[]> {
  return listPayoutsForPartners([partnerId]);
}

/** Payout history across all of a creator's partner rows. */
export async function listPayoutsForPartners(
  partnerIds: string[],
): Promise<AffiliatePayoutRow[]> {
  if (partnerIds.length === 0) return [];
  const { data } = await supabase
    .from('AffiliatePayout')
    .select('*')
    .in('partnerId', partnerIds)
    .order('createdAt', { ascending: false })
    .limit(100);
  return (data ?? []) as AffiliatePayoutRow[];
}
