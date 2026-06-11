import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

export type PayoutStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface AffiliatePayoutRow {
  id: string;
  spaceId: string;
  partnerId: string;
  amountCents: number;
  method: string | null;
  status: PayoutStatus;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface PayoutWithPartner extends AffiliatePayoutRow {
  partnerName: string;
  partnerEmail: string;
}

/** Approved-but-unpaid commission total for one partner. */
export async function getPayableBalanceCents(partnerId: string): Promise<number> {
  const { data } = await supabase
    .from('AffiliateCommission')
    .select('amountCents')
    .eq('partnerId', partnerId)
    .eq('status', 'approved');
  return (data ?? []).reduce((sum, c) => sum + (c.amountCents ?? 0), 0);
}

/**
 * Pay out one partner: marks every approved commission paid and records the
 * payout. Returns null when there is nothing to pay.
 */
export async function createPayout(
  spaceId: string,
  partnerId: string,
): Promise<AffiliatePayoutRow | null> {
  const { data: commissions } = await supabase
    .from('AffiliateCommission')
    .select('id, amountCents, createdAt')
    .eq('spaceId', spaceId)
    .eq('partnerId', partnerId)
    .eq('status', 'approved');

  if (!commissions || commissions.length === 0) return null;
  const total = commissions.reduce((sum, c) => sum + (c.amountCents ?? 0), 0);
  if (total <= 0) return null;

  const { data: partner } = await supabase
    .from('AffiliatePartner')
    .select('payoutMethod')
    .eq('id', partnerId)
    .maybeSingle();

  const dates = commissions.map((c) => new Date(c.createdAt).getTime());
  const { data: payout, error } = await supabase
    .from('AffiliatePayout')
    .insert({
      spaceId,
      partnerId,
      amountCents: total,
      method: partner?.payoutMethod ?? null,
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
  const { data } = await supabase
    .from('AffiliatePayout')
    .select('*')
    .eq('partnerId', partnerId)
    .order('createdAt', { ascending: false })
    .limit(100);
  return (data ?? []) as AffiliatePayoutRow[];
}
