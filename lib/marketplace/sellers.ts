import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { getStripe } from '@/lib/stripe';

/**
 * Seller payouts — Stripe Connect (Express) for the SELLER side of the
 * marketplace. Marketplace charges land on the platform account; a seller
 * who connects here receives their proceeds (sale minus the gross creator
 * commission) as an automatic transfer the moment an order is paid.
 * Unconnected sellers accrue proceeds on the platform balance for manual
 * settlement — nothing is lost, just not yet automatic.
 */

export function sellerPayoutsConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export async function getSellerConnectAccountId(spaceId: string): Promise<string | null> {
  const { data } = await supabase
    .from('Space')
    .select('stripeConnectAccountId')
    .eq('id', spaceId)
    .maybeSingle();
  return (data?.stripeConnectAccountId as string | null) ?? null;
}

/**
 * Ensure the Space has a Connect Express account and return a fresh
 * onboarding link. Null when Stripe isn't configured or creation fails.
 */
export async function createSellerConnectOnboardingLink(
  space: { id: string; slug: string },
  ownerEmail: string | null,
  origin: string,
): Promise<string | null> {
  if (!sellerPayoutsConfigured()) return null;

  try {
    const stripe = getStripe();

    let accountId = await getSellerConnectAccountId(space.id);
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        ...(ownerEmail ? { email: ownerEmail } : {}),
        capabilities: { transfers: { requested: true } },
        metadata: { spaceId: space.id },
      });
      accountId = account.id;
      await supabase
        .from('Space')
        .update({ stripeConnectAccountId: accountId })
        .eq('id', space.id);
    }

    const base = origin.replace(/\/$/, '');
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      refresh_url: `${base}/s/${space.slug}/orders?connect=refresh`,
      return_url: `${base}/s/${space.slug}/orders?connect=done`,
    });
    return link.url;
  } catch (err) {
    logger.warn('[marketplace] seller connect onboarding failed', {
      spaceId: space.id,
      err: String(err),
    });
    return null;
  }
}

/**
 * Transfer a paid order's seller proceeds to the connected account.
 * Returns the transfer id, or null when Stripe / the account isn't ready —
 * the order keeps sellerPayoutCents recorded for manual settlement.
 */
export async function transferSellerProceeds(input: {
  orderId: string;
  spaceId: string;
  amountCents: number;
  currency?: string;
}): Promise<string | null> {
  if (!sellerPayoutsConfigured() || input.amountCents <= 0) return null;
  const accountId = await getSellerConnectAccountId(input.spaceId);
  if (!accountId) return null;

  try {
    const transfer = await getStripe().transfers.create({
      amount: input.amountCents,
      currency: input.currency ?? 'usd',
      destination: accountId,
      metadata: { orderId: input.orderId, kind: 'seller_proceeds' },
    });
    return transfer.id;
  } catch (err) {
    logger.warn('[marketplace] seller proceeds transfer failed — recorded for manual settlement', {
      orderId: input.orderId,
      err: String(err),
    });
    return null;
  }
}
