import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { getStripe } from '@/lib/stripe';

/**
 * Bridge settlement — collecting what sellers owe.
 *
 * Marketplace sales settle themselves (the platform holds the charge and
 * forwards seller proceeds). Bridge sales are the opposite: the SELLER's
 * Stripe holds the money, and the gross commission (creator net + Cola's
 * fee) accrues here as a receivable. Settlement invoices the seller's
 * existing billing customer ("Space"."stripeCustomerId" — the same card
 * that pays their Cola subscription) and stamps the commissions settled.
 * That money funds the creator payouts that go out via Connect transfers.
 */

export interface SettlementResult {
  invoiceId: string;
  totalCents: number;
  commissionCount: number;
}

/** Gross owed by a seller for unsettled bridge commissions. */
export async function getBridgeOwedCents(spaceId: string): Promise<number> {
  const { data } = await supabase
    .from('AffiliateCommission')
    .select('amountCents')
    .eq('spaceId', spaceId)
    .eq('source', 'stripe_bridge')
    .neq('status', 'rejected')
    .is('settledAt', null);
  return (data ?? []).reduce((sum, c) => sum + (c.amountCents ?? 0), 0);
}

/** Spaces that currently owe anything (for the settlement cron). */
export async function listSpacesWithBridgeDebt(): Promise<string[]> {
  const { data } = await supabase
    .from('AffiliateCommission')
    .select('spaceId')
    .eq('source', 'stripe_bridge')
    .neq('status', 'rejected')
    .is('settledAt', null);
  return [...new Set((data ?? []).map((r) => r.spaceId))];
}

/**
 * Invoice one seller for everything they owe. Charges automatically against
 * their saved payment method. Returns null when there's nothing to settle,
 * Stripe isn't configured, or the seller has no billing customer (the debt
 * stays visible and collectable later — never silently written off).
 */
export async function runBridgeSettlement(spaceId: string): Promise<SettlementResult | null> {
  const { data: commissions } = await supabase
    .from('AffiliateCommission')
    .select('id, amountCents')
    .eq('spaceId', spaceId)
    .eq('source', 'stripe_bridge')
    .neq('status', 'rejected')
    .is('settledAt', null);

  if (!commissions || commissions.length === 0) return null;
  const totalCents = commissions.reduce((sum, c) => sum + (c.amountCents ?? 0), 0);
  if (totalCents <= 0) return null;

  if (!process.env.STRIPE_SECRET_KEY) {
    logger.info('[settlement] stripe not configured — debt remains on ledger', { spaceId, totalCents });
    return null;
  }

  const { data: space } = await supabase
    .from('Space')
    .select('stripeCustomerId, name')
    .eq('id', spaceId)
    .maybeSingle();
  if (!space?.stripeCustomerId) {
    logger.info('[settlement] seller has no billing customer — debt remains on ledger', { spaceId });
    return null;
  }

  try {
    const stripe = getStripe();
    await stripe.invoiceItems.create({
      customer: space.stripeCustomerId,
      amount: totalCents,
      currency: 'usd',
      description: `Affiliate commissions — ${commissions.length} conversion${commissions.length === 1 ? '' : 's'} in your app, owed to your creators`,
    });
    const invoice = await stripe.invoices.create({
      customer: space.stripeCustomerId,
      collection_method: 'charge_automatically',
      auto_advance: true,
      description: 'Cola affiliate commission settlement',
    });

    const settledAt = new Date().toISOString();
    const { error } = await supabase
      .from('AffiliateCommission')
      .update({ settledAt, settlementInvoiceId: invoice.id })
      .in('id', commissions.map((c) => c.id));
    if (error) {
      logger.error('[settlement] invoice created but stamping failed — reconcile manually', {
        spaceId,
        invoiceId: invoice.id,
        error: error.message,
      });
    }

    return { invoiceId: invoice.id ?? 'unknown', totalCents, commissionCount: commissions.length };
  } catch (err) {
    logger.warn('[settlement] stripe invoicing failed — debt remains on ledger', {
      spaceId,
      err: String(err),
    });
    return null;
  }
}
