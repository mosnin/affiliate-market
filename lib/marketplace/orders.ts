import { randomBytes } from 'node:crypto';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { recordConversion } from '@/lib/affiliates/conversions';
import { reverseCommissionsForOrder } from '@/lib/affiliates/reversals';
import { transferSellerProceeds } from '@/lib/marketplace/sellers';
import { getMarketplaceFeeBps, gmvFeeCents } from '@/lib/marketplace/fees';
import {
  sendOrderReceiptEmail,
  sendOrderRefundedEmail,
  sendSellerNewSaleEmail,
} from '@/lib/marketplace/emails';
import { getSpaceOwnerEmail } from '@/lib/space';

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
  // Product is this domain's table (Convex); Space is a core table (Convex).
  const [products, spacesRes] = await Promise.all([
    convex().query(api.marketplace.products.byIds, { ids: productIds }),
    convex().query(api.workspace.spaces.listByIds, { ids: spaceIds }),
  ]);
  const productById = new Map(
    (products as Array<{ id: string; name: string | null; address: string | null }>).map((p) => [
      p.id,
      p,
    ]),
  );
  const spaces = new Map((spacesRes ?? []).map((s) => [s.id, s]));

  return rows.map((r) => {
    const product = productById.get(r.productId);
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
  const data = await convex().query(api.marketplace.orders.getById, { id });
  if (!data) return null;
  const [order] = await decorateOrders([data as OrderRow]);
  return order ?? null;
}

export async function getOrderByStripeSession(sessionId: string): Promise<OrderWithProduct | null> {
  const data = await convex().query(api.marketplace.orders.getByStripeSession, { sessionId });
  if (!data) return null;
  const [order] = await decorateOrders([data as OrderRow]);
  return order ?? null;
}

export async function getOrdersForBuyerEmail(email: string): Promise<OrderWithProduct[]> {
  const data = await convex().query(api.marketplace.orders.listByBuyerEmail, {
    email: email.trim().toLowerCase(),
  });
  return decorateOrders((data ?? []) as OrderRow[]);
}

export async function getOrdersForSpace(spaceId: string): Promise<OrderWithProduct[]> {
  const data = await convex().query(api.marketplace.orders.listBySpace, { spaceId });
  return decorateOrders((data ?? []) as OrderRow[]);
}

export async function getLicensesForBuyerEmail(email: string): Promise<LicenseWithProduct[]> {
  const licenses = (await convex().query(api.marketplace.orders.licensesByBuyerEmail, {
    email: email.trim().toLowerCase(),
  })) as Array<{
    id: string;
    orderId: string;
    productId: string;
    licenseKey: string;
    status: string;
    deliveredAt: string;
    expiresAt: string | null;
  }>;
  if (!licenses || licenses.length === 0) return [];

  const productIds = [...new Set(licenses.map((l) => l.productId))];
  const products = (await convex().query(api.marketplace.products.byIds, {
    ids: productIds,
  })) as Array<{ id: string; name: string | null; address: string | null }>;
  const byId = new Map(products.map((p) => [p.id, p]));

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
  const l = (await convex().query(api.marketplace.orders.licenseForOrder, { orderId })) as {
    id: string;
    orderId: string;
    productId: string;
    licenseKey: string;
    status: string;
    deliveredAt: string;
    expiresAt: string | null;
  } | null;
  if (!l) return null;
  const [product] = (await convex().query(api.marketplace.products.byIds, {
    ids: [l.productId],
  })) as Array<{ id: string; name: string | null; address: string | null }>;
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

/** COLA-XXXX-XXXX-XXXX-XXXX license key (crockford-ish, no ambiguous chars).
 *  Kept for callers/tests; license delivery itself now mints the key inside the
 *  Convex claimPending mutation (same algorithm) so it can enforce uniqueness. */
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
  try {
    const data = (await convex().mutation(api.marketplace.orders.createPending, {
      spaceId: input.spaceId,
      productId: input.productId,
      buyerEmail: input.buyerEmail.trim().toLowerCase(),
      clientUserId: input.clientUserId ?? null,
      amountCents: input.amountCents,
      currency: input.currency || 'usd',
      referralCode: input.referralCode,
      discountCents: input.discountCents ?? 0,
    })) as OrderRow;
    return data ?? null;
  } catch (err) {
    logger.warn('[marketplace] createPendingOrder failed', { error: String(err) });
    return null;
  }
}

export async function attachStripeSession(orderId: string, sessionId: string): Promise<void> {
  await convex().mutation(api.marketplace.orders.attachStripe, {
    orderId,
    stripeCheckoutSessionId: sessionId,
  });
}

/** Recorded at payment so charge.refunded events can find their order. */
export async function attachStripePaymentIntent(
  orderId: string,
  paymentIntentId: string,
): Promise<void> {
  await convex().mutation(api.marketplace.orders.attachStripe, {
    orderId,
    stripePaymentIntentId: paymentIntentId,
  });
}

export async function getOrderByStripePaymentIntent(
  paymentIntentId: string,
): Promise<OrderWithProduct | null> {
  const data = await convex().query(api.marketplace.orders.getByStripePaymentIntent, {
    paymentIntentId,
  });
  if (!data) return null;
  const [order] = await decorateOrders([data as OrderRow]);
  return order ?? null;
}

export async function attachStripeCustomer(orderId: string, customerId: string): Promise<void> {
  await convex().mutation(api.marketplace.orders.attachStripe, {
    orderId,
    stripeCustomerId: customerId,
  });
}

/** Most recent Stripe customer id for a buyer's subscription purchase, if any. */
export async function getStripeCustomerForBuyer(email: string): Promise<string | null> {
  return convex().query(api.marketplace.orders.stripeCustomerForBuyer, {
    email: email.trim().toLowerCase(),
  });
}

/** Recorded when a subscription checkout completes — renewals look it up. */
export async function attachStripeSubscription(
  orderId: string,
  subscriptionId: string,
): Promise<void> {
  await convex().mutation(api.marketplace.orders.attachStripe, {
    orderId,
    stripeSubscriptionId: subscriptionId,
  });
}

export async function getOrderByStripeSubscription(
  subscriptionId: string,
): Promise<OrderWithProduct | null> {
  const data = await convex().query(api.marketplace.orders.getByStripeSubscription, {
    subscriptionId,
  });
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
 *
 * The status flip + license delivery are now ONE serializable Convex mutation
 * (claimPending) — strictly stronger than the old non-atomic CAS-then-insert.
 * The CROSS-DOMAIN work stays here in lib (per convex/CONVENTIONS): the affiliate
 * conversion (Supabase), the Stripe transfer, and the emails. The money math is
 * unchanged — gross commission from recordConversion, the 10% GMV fee, and
 * sellerPayoutCents = amount − commission − gmvFee.
 */
export async function markOrderPaid(orderId: string): Promise<OrderWithProduct | null> {
  const claim = (await convex().mutation(api.marketplace.orders.claimPending, { orderId })) as {
    outcome: 'claimed' | 'already' | 'missing';
    order: OrderRow | null;
    licenseKey: string | null;
  };
  if (claim.outcome === 'missing') return null;
  // Already paid / lost the idempotency race → another caller finished the job.
  if (claim.outcome === 'already') return getOrderById(orderId);

  const order = claim.order as OrderRow;
  const licenseKey = claim.licenseKey as string;

  // Affiliate attribution — never blocks fulfilment. (Affiliates stay on Supabase.)
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

  // Platform GMV fee — Cola's cut of every marketplace sale, on top of the
  // 20% it takes from the creator commission. Comes out of the seller's side.
  const feeBps = await getMarketplaceFeeBps(order.spaceId);
  const platformGmvFeeCents = gmvFeeCents(order.amountCents, feeBps);

  // Seller proceeds: the sale minus what the seller owes the creator minus
  // the platform GMV fee. Transfers immediately when the seller has Connect;
  // otherwise the amount is recorded and the platform balance holds it.
  const sellerPayoutCents = Math.max(0, order.amountCents - grossCommissionCents - platformGmvFeeCents);
  const sellerTransferId = await transferSellerProceeds({
    orderId: order.id,
    spaceId: order.spaceId,
    amountCents: sellerPayoutCents,
    currency: order.currency,
  });
  try {
    await convex().mutation(api.marketplace.orders.recordSellerProceeds, {
      orderId: order.id,
      sellerPayoutCents,
      platformGmvFeeCents,
      sellerTransferId: sellerTransferId ?? null,
    });
  } catch (err) {
    logger.error('[marketplace] failed to record seller proceeds', {
      orderId: order.id,
      error: String(err),
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

    // Tell the seller they made a sale (transactional). The owner lookup + send
    // are fire-and-forget — fulfilment already happened above.
    const productName = decorated.productName;
    void (async () => {
      const owner = await getSpaceOwnerEmail(order.spaceId);
      if (!owner) return;
      const base = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
      await sendSellerNewSaleEmail({
        to: owner.email,
        productName,
        buyerEmail: order.buyerEmail,
        amountCents: order.amountCents,
        proceedsCents: sellerPayoutCents,
        orderId: order.id,
        dashboardUrl: `${base}/s/${owner.slug}/orders`,
      });
    })();
  }
  return decorated;
}

/**
 * The unhappy path, in one place: a refunded (or disputed) order revokes
 * its license and claws back its commissions. Idempotent — a second call
 * on an already-refunded order does nothing.
 *
 * The status flip + license revoke are now ONE serializable Convex mutation
 * (markRefunded). The commission clawback (affiliates → Supabase) and the refund
 * email stay here in lib, gated on the mutation reporting a real transition.
 */
export async function markOrderRefunded(
  orderId: string,
  reason: string,
): Promise<OrderWithProduct | null> {
  const result = (await convex().mutation(api.marketplace.orders.markRefunded, { orderId })) as {
    outcome: 'refunded' | 'noop' | 'missing';
    order: OrderRow | null;
  };
  if (result.outcome === 'missing') return null;
  if (result.outcome === 'noop') return getOrderById(orderId); // already refunded or never paid

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
