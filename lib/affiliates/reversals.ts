import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

/**
 * Commission reversals — the unhappy money path.
 *
 * When a payment comes back (refund, dispute), its commission must come
 * back too:
 *   * pending/approved → 'reversed': it simply never becomes payable
 *   * paid             → 'reversed' AND the creator's balance adjustment
 *     goes negative by the net amount; the next payout absorbs the debt
 *     before any new money moves
 *   * settled bridge commissions get a note for manual reconciliation —
 *     the seller was already invoiced; crediting them back is a human
 *     decision, never an automatic write-off.
 *
 * Idempotent: an already-reversed commission is left alone.
 */

export interface ReversalResult {
  reversed: number;
  clawedBackCents: number;
}

interface CommissionRow {
  id: string;
  partnerId: string;
  status: string;
  netCents: number | null;
  amountCents: number;
  source: string;
  settledAt: string | null;
}

async function reverseRows(rows: CommissionRow[], reason: string): Promise<ReversalResult> {
  let reversed = 0;
  let clawedBackCents = 0;
  const reversedAt = new Date().toISOString();

  for (const c of rows) {
    if (c.status === 'reversed' || c.status === 'rejected') continue;

    const wasPaid = c.status === 'paid';
    const settledNote =
      c.source === 'stripe_bridge' && c.settledAt
        ? ' (bridge commission already settled by seller — reconcile manually)'
        : '';

    const { error } = await supabase
      .from('AffiliateCommission')
      .update({
        status: 'reversed',
        reversedAt,
        reversalReason: `${reason}${settledNote}`,
      })
      .eq('id', c.id)
      .neq('status', 'reversed');
    if (error) {
      logger.error('[affiliates] reversal update failed', { id: c.id, error: error.message });
      continue;
    }
    reversed += 1;

    if (wasPaid) {
      const net = c.netCents ?? c.amountCents ?? 0;
      if (net > 0) {
        // Read-modify-write is fine here: reversals are rare and serialized
        // per webhook delivery; Stripe retries reuse the same commission ids,
        // which the status guard above already made idempotent.
        const { data: partner } = await supabase
          .from('AffiliatePartner')
          .select('balanceAdjustmentCents')
          .eq('id', c.partnerId)
          .maybeSingle();
        const current = partner?.balanceAdjustmentCents ?? 0;
        await supabase
          .from('AffiliatePartner')
          .update({ balanceAdjustmentCents: current - net })
          .eq('id', c.partnerId);
        clawedBackCents += net;
      }
    }
  }

  if (reversed > 0) {
    logger.info('[affiliates] commissions reversed', { reversed, clawedBackCents, reason });
  }
  return { reversed, clawedBackCents };
}

/** Reverse the commission tied to one Stripe invoice (subscription periods). */
export async function reverseCommissionsForInvoice(
  stripeInvoiceId: string,
  reason: string,
): Promise<ReversalResult> {
  const { data } = await supabase
    .from('AffiliateCommission')
    .select('id, partnerId, status, netCents, amountCents, source, settledAt')
    .eq('stripeInvoiceId', stripeInvoiceId);
  return reverseRows((data ?? []) as CommissionRow[], reason);
}

/** Reverse every commission tied to one marketplace order. */
export async function reverseCommissionsForOrder(
  orderId: string,
  reason: string,
): Promise<ReversalResult> {
  const { data } = await supabase
    .from('AffiliateCommission')
    .select('id, partnerId, status, netCents, amountCents, source, settledAt')
    .eq('orderId', orderId);
  return reverseRows((data ?? []) as CommissionRow[], reason);
}
