import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { transferPayout } from '@/lib/affiliates/stripe-connect';
import { sendPayoutCompletedEmail } from '@/lib/affiliates/emails';

/** Best-effort "you've been paid" email — never blocks the payout itself. */
async function notifyPayoutCompleted(
  partnerId: string,
  amountCents: number,
  method: string | null,
): Promise<void> {
  const { data: partner } = await supabase
    .from('AffiliatePartner')
    .select('name, email')
    .eq('id', partnerId)
    .maybeSingle();
  if (partner) {
    void sendPayoutCompletedEmail({
      to: partner.email,
      partnerName: partner.name,
      amountCents,
      method,
    });
  }
}

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

/**
 * Combined approved-but-unpaid NET balance across a creator's partner rows,
 * after absorbing any negative balance adjustments (refund clawbacks on
 * already-paid commissions). Never below zero — a creator in debt simply
 * has nothing payable until new commissions cover it.
 */
export async function getPayableBalanceCentsForPartners(
  partnerIds: string[],
): Promise<number> {
  if (partnerIds.length === 0) return 0;
  const [commissionsRes, partnersRes] = await Promise.all([
    supabase
      .from('AffiliateCommission')
      .select('amountCents, netCents')
      .in('partnerId', partnerIds)
      .eq('status', 'approved'),
    supabase
      .from('AffiliatePartner')
      .select('balanceAdjustmentCents')
      .in('id', partnerIds),
  ]);
  const approved = (commissionsRes.data ?? []).reduce(
    (sum, c) => sum + (c.netCents ?? c.amountCents ?? 0),
    0,
  );
  const adjustment = (partnersRes.data ?? []).reduce(
    (sum, p) => sum + (p.balanceAdjustmentCents ?? 0),
    0,
  );
  return Math.max(0, approved + adjustment);
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
  const approvedNet = commissions.reduce((sum, c) => sum + (c.netCents ?? c.amountCents ?? 0), 0);
  const feeTotal = commissions.reduce((sum, c) => sum + (c.platformFeeCents ?? 0), 0);

  const { data: partner } = await supabase
    .from('AffiliatePartner')
    .select('payoutMethod, stripeAccountId, balanceAdjustmentCents')
    .eq('id', partnerId)
    .maybeSingle();

  // Refund clawbacks eat into the payout before any money moves. When the
  // debt exceeds what's approved, mark the commissions paid-against-debt and
  // carry the remainder — no transfer happens.
  const adjustment = partner?.balanceAdjustmentCents ?? 0;
  const netTotal = approvedNet + adjustment;
  if (netTotal <= 0) {
    if (adjustment < 0 && approvedNet > 0) {
      await supabase
        .from('AffiliateCommission')
        .update({ status: 'paid' })
        .in('id', commissions.map((c) => c.id));
      await supabase
        .from('AffiliatePartner')
        .update({ balanceAdjustmentCents: adjustment + approvedNet })
        .eq('id', partnerId);
      logger.info('[affiliates] approved commissions consumed by clawback debt', {
        partnerId,
        approvedNet,
        remainingDebt: adjustment + approvedNet,
      });
    }
    return null;
  }

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

  // The payout consumed the clawback debt — zero it.
  if (adjustment !== 0) {
    await supabase
      .from('AffiliatePartner')
      .update({ balanceAdjustmentCents: 0 })
      .eq('id', partnerId);
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
    if (completed) {
      void notifyPayoutCompleted(partnerId, netTotal, 'stripe');
      return completed as AffiliatePayoutRow;
    }
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
  const { data, error } = await supabase
    .from('AffiliatePayout')
    .update({ status: 'completed', paidAt: new Date().toISOString() })
    .eq('id', payoutId)
    .select('partnerId, amountCents, method')
    .maybeSingle();
  if (!error && data) {
    void notifyPayoutCompleted(data.partnerId, data.amountCents, data.method);
  }
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
