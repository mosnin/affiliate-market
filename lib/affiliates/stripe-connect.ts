import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { getStripe } from '@/lib/stripe';
import type { AffiliatePartnerRow } from '@/lib/affiliates/partners';

/**
 * Stripe Connect (Express) for creator payouts. Creators connect their own
 * Stripe account once; payout batches then transfer their net earnings
 * directly. Everything here no-ops gracefully when STRIPE_SECRET_KEY is
 * absent so local/dev never blocks on Stripe.
 */

export function stripeConnectConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Ensure the partner has a Connect Express account and return a fresh
 * onboarding link the creator can be redirected to. Returns null when
 * Stripe isn't configured or the account can't be created.
 */
export async function createConnectOnboardingLink(
  partner: AffiliatePartnerRow,
  origin: string,
): Promise<string | null> {
  if (!stripeConnectConfigured()) return null;

  try {
    const stripe = getStripe();

    let accountId = partner.stripeAccountId;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: partner.email,
        capabilities: { transfers: { requested: true } },
        metadata: { partnerId: partner.id },
      });
      accountId = account.id;
      await supabase
        .from('AffiliatePartner')
        .update({ stripeAccountId: accountId })
        .eq('id', partner.id);
    }

    const base = origin.replace(/\/$/, '');
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      refresh_url: `${base}/affiliate/payouts?connect=refresh`,
      return_url: `${base}/affiliate/payouts?connect=done`,
    });
    return link.url;
  } catch (err) {
    logger.warn('[affiliates] connect onboarding link failed', {
      partnerId: partner.id,
      err: String(err),
    });
    return null;
  }
}

/** Whether the connected account can actually receive transfers yet. */
export async function isConnectAccountReady(stripeAccountId: string | null): Promise<boolean> {
  if (!stripeAccountId || !stripeConnectConfigured()) return false;
  try {
    const account = await getStripe().accounts.retrieve(stripeAccountId);
    return Boolean(account.payouts_enabled);
  } catch {
    return false;
  }
}

/**
 * Transfer a payout's net amount to the creator's connected account.
 * Returns the transfer id, or null when Stripe/the account isn't ready —
 * the payout then stays 'pending' for manual settlement.
 */
export async function transferPayout(input: {
  payoutId: string;
  stripeAccountId: string | null;
  amountCents: number;
  currency?: string;
}): Promise<string | null> {
  if (!stripeConnectConfigured() || !input.stripeAccountId) return null;
  if (input.amountCents <= 0) return null;

  try {
    // Idempotency key = payoutId: a network-timeout retry where Stripe actually
    // created the transfer returns the SAME transfer instead of moving cash twice.
    const transfer = await getStripe().transfers.create(
      {
        amount: input.amountCents,
        currency: input.currency ?? 'usd',
        destination: input.stripeAccountId,
        metadata: { payoutId: input.payoutId },
      },
      { idempotencyKey: `payout_transfer_${input.payoutId}` },
    );
    return transfer.id;
  } catch (err) {
    logger.warn('[affiliates] stripe transfer failed — payout left pending', {
      payoutId: input.payoutId,
      err: String(err),
    });
    return null;
  }
}
