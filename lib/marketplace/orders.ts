import { randomBytes } from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { recordConversion } from '@/lib/affiliates/conversions';
import { reverseCommissionsForOrder } from '@/lib/affiliates/reversals';
import { transferSellerProceeds } from '@/lib/marketplace/sellers';
import { sendOrderReceiptEmail, sendOrderRefundedEmail } from '@/lib/marketplace/emails';

export type OrderStatus = 'pending' | 'paid' | 'refunded' | 'canceled';
export type LicenseStatus = 'active' | 'revoked' | 'expired';

export interface OrderWithProduct {
  id: string;
  spaceId: string;
  productId: string;
  productName: string;
  sellerName: string;
  buyerEmail: string;
  amountCents: number;
  currency: string;
  status: OrderStatus;
  referralCode: string | null;
  stripeCheckoutSessionId: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface LicenseWithProduct {
  id: string;
  orderId: string;
  productName: string;
  licenseKey: string;
  status: LicenseStatus;
  deliveredAt: string;
  expiresAt: string | null;
}

interface OrderRow {
  id: string;
  spaceId: string;
  productId: string;
  buyerEmail: string;
  amountCents: number;
  currency: string;
  status: string;
  referralCode: string | null;
  stripeCheckoutSessionId: string | null;
  createdAt: string;
  paidAt: string | null;
}

async function decorateOrders(rows: OrderRow[]): Promise<OrderWithProduct[]> {
  if (rows.length === 0) return [];
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const spaceIds = [...new Set(rows.map((r) => r.spaceId))];
  const [productsRes, spacesRes] = await Promise.all([
    supabase.from('Product').select('id, name, address').in('id', productIds),
    supabase.from('Space').select('id, name').in('id', spaceIds),
  ]);
  const products = new Map((productsRes.data ?? []).map((p) => [p.id, p]));
  const spaces = new Map((spacesRes.data ?? []).map((s) => [s.id, s]));

  return rows.map((r) => {
    const product = products.get(r.productId);
    return {
      id: r.id,
      spaceId: r.spaceId,
      productId: r.productId,
      productName: product?.name ?? product?.address ?? 'Unknown product',
      sellerName: spaces.get(r.spaceId)?.name ?? 'Unknown seller',
      buyerEmail: r.buyerEmail,
      amountCents: r.amountCents ?? 0,
      currency: r.currency ?? 'usd',
      status: r.status as OrderStatus,
      referralCode: r.referralCode,
      stripeCheckoutSessionId: r.stripeCheckoutSessionId,
      createdAt: r.createdAt,
      paidAt: r.paidAt,
    };
  });
}

export async function getOrderById(id: string): Promise<OrderWithProduct | null> {
  const { data } = await supabase.from('MarketplaceOrder').select('*').eq('id', id).maybeSingle();
  if (!data) return null;
  const [order] = await decorateOrders([data as OrderRow]);
  return order ?? null;
}

export async function getOrderByStripeSession(sessionId: string): Promise<OrderWithProduct | null> {
  const { data } = await supabase
    .from('MarketplaceOrder')
    .select('*')
    .eq('stripeCheckoutSessionId', sessionId)
    .maybeSingle();
  if (!data) return null;
  const [order] = await decorateOrders([data as OrderRow]);
  return order ?? null;
}

export async function getOrdersForBuyerEmail(email: string): Promise<OrderWithProduct[]> {
  const { data } = await supabase
    .from('MarketplaceOrder')
    .select('*')
    .ilike('buyerEmail', email.trim().toLowerCase())
    .order('createdAt', { ascending: false })
    .limit(100);
  return decorateOrders((data ?? []) as OrderRow[]);
}

export async function getOrdersForSpace(spaceId: string): Promise<OrderWithProduct[]> {
  const { data } = await supabase
    .from('MarketplaceOrder')
    .select('*')
    .eq('spaceId', spaceId)
    .order('createdAt', { ascending: false })
    .limit(200);
  return decorateOrders((data ?? []) as OrderRow[]);
}

export async function getLicensesForBuyerEmail(email: string): Promise<LicenseWithProduct[]> {
  const { data: licenses } = await supabase
    .from('License')
    .select('*')
    .ilike('buyerEmail', email.trim().toLowerCase())
    .order('deliveredAt', { ascending: false })
    .limit(100);
  if (!licenses || licenses.length === 0) return [];

  const productIds = [...new Set(licenses.map((l) => l.productId))];
  const { data: products } = await supabase
    .from('Product')
    .select('id, name, address')
    .in('id', productIds);
  const byId = new Map((products ?? []).map((p) => [p.id, p]));

  return licenses.map((l) => ({
    id: l.id,
    orderId: l.orderId,
    productName: byId.get(l.productId)?.name ?? byId.get(l.productId)?.address ?? 'Unknown product',
    licenseKey: l.licenseKey,
    status: l.status as LicenseStatus,
    deliveredAt: l.deliveredAt,
    expiresAt: l.expiresAt,
  }));
}

export async function getLicenseForOrder(orderId: string): Promise<LicenseWithProduct | null> {
  const { data: l } = await supabase
    .from('License')
    .select('*')
    .eq('orderId', orderId)
    .maybeSingle();
  if (!l) return null;
  const { data: product } = await supabase
    .from('Product')
    .select('name, address')
    .eq('id', l.productId)
    .maybeSingle();
  return {
    id: l.id,
    orderId: l.orderId,
    productName: product?.name ?? product?.address ?? 'Unknown product',
    licenseKey: l.licenseKey,
    status: l.status as LicenseStatus,
    deliveredAt: l.deliveredAt,
    expiresAt: l.expiresAt,
  };
}

/** COLA-XXXX-XXXX-XXXX-XXXX license key (crockford-ish, no ambiguous chars). */
export function generateLicenseKey(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  const groups = [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join(''));
  return `COLA-${groups.join('-')}`;
}

export async function createPendingOrder(input: {
  spaceId: string;
  productId: string;
  buyerEmail: string;
  amountCents: number;
  currency: string;
  referralCode: string | null;
  discountCents?: number;
  clientUserId?: string | null;
}): Promise<OrderRow | null> {
  const { data, error } = await supabase
    .from('MarketplaceOrder')
    .insert({
      spaceId: input.spaceId,
      productId: input.productId,
      buyerEmail: input.buyerEmail.trim().toLowerCase(),
      clientUserId: input.clientUserId ?? null,
      amountCents: input.amountCents,
      currency: input.currency || 'usd',
      status: 'pending',
      referralCode: input.referralCode,
      discountCents: input.discountCents ?? 0,
    })
    .select('*')
    .single();
  if (error || !data) {
    logger.warn('[marketplace] createPendingOrder failed', { error: error?.message });
    return null;
  }
  return data as OrderRow;
}

export async function attachStripeSession(orderId: string, sessionId: string): Promise<void> {
  await supabase
    .from('MarketplaceOrder')
    .update({ stripeCheckoutSessionId: sessionId })
    .eq('id', orderId);
}

/** Recorded at payment so charge.refunded events can find their order. */
export async function attachStripePaymentIntent(
  orderId: string,
  paymentIntentId: string,
): Promise<void> {
  await supabase
    .from('MarketplaceOrder')
    .update({ stripePaymentIntentId: paymentIntentId })
    .eq('id', orderId);
}

export async function getOrderByStripePaymentIntent(
  paymentIntentId: string,
): Promise<OrderWithProduct | null> {
  const { data } = await supabase
    .from('MarketplaceOrder')
    .select('*')
    .eq('stripePaymentIntentId', paymentIntentId)
    .maybeSingle();
  if (!data) return null;
  const [order] = await decorateOrders([data as OrderRow]);
  return order ?? null;
}

export async function attachStripeCustomer(orderId: string, customerId: string): Promise<void> {
  await supabase
    .from('MarketplaceOrder')
    .update({ stripeCustomerId: customerId })
    .eq('id', orderId);
}

/** Most recent Stripe customer id for a buyer's subscription purchase, if any. */
export async function getStripeCustomerForBuyer(email: string): Promise<string | null> {
  const { data } = await supabase
    .from('MarketplaceOrder')
    .select('stripeCustomerId')
    .ilike('buyerEmail', email.trim().toLowerCase())
    .not('stripeCustomerId', 'is', null)
    .order('createdAt', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.stripeCustomerId as string | null) ?? null;
}

/** Recorded when a subscription checkout completes — renewals look it up. */
export async function attachStripeSubscription(
  orderId: string,
  subscriptionId: string,
): Promise<void> {
  await supabase
    .from('MarketplaceOrder')
    .update({ stripeSubscriptionId: subscriptionId })
    .eq('id', orderId);
}

export async function getOrderByStripeSubscription(
  subscriptionId: string,
): Promise<OrderWithProduct | null> {
  const { data } = await supabase
    .from('MarketplaceOrder')
    .select('*')
    .eq('stripeSubscriptionId', subscriptionId)
    .maybeSingle();
  if (!data) return null;
  const [order] = await decorateOrders([data as OrderRow]);
  return order ?? null;
}

/**
 * Single place an order becomes PAID — used by the Stripe webhook, the
 * success-page reconciliation, and the no-Stripe mock flow. Idempotent:
 * a second call on a paid order does nothing.
 *
 * On first transition: delivers the license, records the affiliate
 * conversion (best-effort), and emails the receipt.
 */
export async function markOrderPaid(orderId: string): Promise<OrderWithProduct | null> {
  const { data: existing } = await supabase
    .from('MarketplaceOrder')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();
  if (!existing) return null;
  if (existing.status === 'paid') return (await getOrderById(orderId))!;

  const paidAt = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from('MarketplaceOrder')
    .update({ status: 'paid', paidAt })
    .eq('id', orderId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) {
    logger.warn('[marketplace] markOrderPaid update failed', { orderId, error: error.message });
    return null;
  }
  // Lost the idempotency race → another caller finished the job.
  if (!updated) return getOrderById(orderId);

  const order = updated as OrderRow;

  // License delivery (unique per order — tolerate duplicate-key on races).
  const licenseKey = generateLicenseKey();
  const { error: licErr } = await supabase.from('License').insert({
    orderId: order.id,
    productId: order.productId,
    buyerEmail: order.buyerEmail,
    licenseKey,
    status: 'active',
  });
  if (licErr && !`${licErr.message}`.toLowerCase().includes('duplicate')) {
    logger.error('[marketplace] license delivery failed', {
      orderId: order.id,
      error: licErr.message,
    });
  }

  // Affiliate attribution — never blocks fulfilment.
  let grossCommissionCents = 0;
  try {
    const conversion = await recordConversion({
      orderId: order.id,
      spaceId: order.spaceId,
      buyerEmail: order.buyerEmail,
      amountCents: order.amountCents,
      currency: order.currency,
      referralCode: order.referralCode,
      productId: order.productId,
    });
    grossCommissionCents = conversion?.commissionCentsTotal ?? 0;
  } catch (err) {
    logger.warn('[marketplace] recordConversion threw', { orderId: order.id, err: String(err) });
  }

  // Seller proceeds: the sale minus what the seller owes the creator.
  // Transfers immediately when the seller has Connect; otherwise the amount
  // is recorded and the platform balance holds it for manual settlement.
  const sellerPayoutCents = Math.max(0, order.amountCents - grossCommissionCents);
  const sellerTransferId = await transferSellerProceeds({
    orderId: order.id,
    spaceId: order.spaceId,
    amountCents: sellerPayoutCents,
    currency: order.currency,
  });
  const { error: payoutErr } = await supabase
    .from('MarketplaceOrder')
    .update({ sellerPayoutCents, ...(sellerTransferId ? { sellerTransferId } : {}) })
    .eq('id', order.id);
  if (payoutErr) {
    logger.error('[marketplace] failed to record seller proceeds', {
      orderId: order.id,
      error: payoutErr.message,
    });
  }

  const decorated = await getOrderById(order.id);
  if (decorated) {
    void sendOrderReceiptEmail({
      to: order.buyerEmail,
      productName: decorated.productName,
      sellerName: decorated.sellerName,
      amountCents: order.amountCents,
      licenseKey,
      orderId: order.id,
    });
  }
  return decorated;
}

/**
 * The unhappy path, in one place: a refunded (or disputed) order revokes
 * its license and claws back its commissions. Idempotent — a second call
 * on an already-refunded order does nothing.
 */
export async function markOrderRefunded(
  orderId: string,
  reason: string,
): Promise<OrderWithProduct | null> {
  const { data: updated, error } = await supabase
    .from('MarketplaceOrder')
    .update({ status: 'refunded', refundedAt: new Date().toISOString() })
    .eq('id', orderId)
    .eq('status', 'paid')
    .select('id, buyerEmail')
    .maybeSingle();
  if (error) {
    logger.warn('[marketplace] markOrderRefunded failed', { orderId, error: error.message });
    return null;
  }
  if (!updated) return getOrderById(orderId); // already refunded or never paid

  await supabase
    .from('License')
    .update({ status: 'revoked' })
    .eq('orderId', orderId)
    .eq('status', 'active');

  await reverseCommissionsForOrder(orderId, reason);

  const decorated = await getOrderById(orderId);
  if (decorated) {
    void sendOrderRefundedEmail({
      to: decorated.buyerEmail,
      productName: decorated.productName,
      amountCents: decorated.amountCents,
      orderId,
    });
  }
  return decorated;
}
