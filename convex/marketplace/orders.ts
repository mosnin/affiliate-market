import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * MarketplaceOrder + License data access — the Convex replacement for the
 * `.from('MarketplaceOrder')` / `.from('License')` reads & writes in
 * lib/marketplace/orders.ts.
 *
 * CROSS-DOMAIN STAYS IN LIB (CONVENTIONS): markOrderPaid orchestrates affiliate
 * commission (recordConversion → AffiliateCommission, NOT migrated → Supabase),
 * Stripe transfers, and emails. Those remain lib→lib/SDK calls. This module only
 * provides the MarketplaceOrder/License table hops those lib functions need:
 *   - claimPending: the idempotent status flip (pending→paid) AND license
 *     delivery, in ONE serializable mutation (both tables are this domain's). The
 *     old code did a CAS update + a separate License insert; folding them removes
 *     the race window where an order is paid but unlicensed.
 *   - recordSellerProceeds: the final cents patch, after the cross-domain calls
 *     in lib computed sellerPayoutCents / platformGmvFeeCents / sellerTransferId.
 *   - markRefunded: status flip (paid→refunded) + license revoke, ONE mutation.
 *     reverseCommissionsForOrder (affiliates) + the refund email stay in lib.
 *
 * Money is moved, never recomputed here — the lib passes already-computed cents.
 *
 * License delivery preserves two PG invariants by read-then-insert inside the
 * mutation: idx_license_order UNIQUE(orderId) (one license per order) and
 * License_licenseKey_key UNIQUE(licenseKey) (globally-unique key).
 */

const orderStatusValidator = v.union(
  v.literal('pending'),
  v.literal('paid'),
  v.literal('refunded'),
  v.literal('canceled'),
);

/** App columns of a MarketplaceOrder — the OrderRow shape lib decorates. Both a
 *  stored Doc and a fresh insert payload satisfy this, so mappers need no cast. */
type OrderFields = {
  id: string;
  spaceId: string;
  productId: string;
  buyerEmail: string;
  clientUserId?: string;
  amountCents: number;
  currency: string;
  status: 'pending' | 'paid' | 'refunded' | 'canceled';
  referralCode?: string;
  stripeCheckoutSessionId?: string;
  createdAt: string;
  paidAt?: string;
  stripeSubscriptionId?: string;
  sellerPayoutCents?: number;
  sellerTransferId?: string;
  refundedAt?: string;
  stripePaymentIntentId?: string;
  discountCents: number;
  stripeCustomerId?: string;
  platformGmvFeeCents: number;
};

/** The OrderRow shape lib/marketplace/orders.ts#OrderRow consumes (the columns
 *  decorateOrders reads). Surface `id`, coerce absent optionals to SQL NULL. */
function toOrderRow(o: OrderFields) {
  return {
    id: o.id,
    spaceId: o.spaceId,
    productId: o.productId,
    buyerEmail: o.buyerEmail,
    amountCents: o.amountCents,
    currency: o.currency,
    status: o.status,
    referralCode: o.referralCode ?? null,
    stripeCheckoutSessionId: o.stripeCheckoutSessionId ?? null,
    createdAt: o.createdAt,
    paidAt: o.paidAt ?? null,
  };
}

type LicenseFields = {
  id: string;
  orderId: string;
  productId: string;
  buyerEmail: string;
  licenseKey: string;
  status: 'active' | 'revoked' | 'expired';
  deliveredAt: string;
  expiresAt?: string;
};

/** The raw License row shape lib reads (productId resolved separately for name). */
function toLicenseRow(l: LicenseFields) {
  return {
    id: l.id,
    orderId: l.orderId,
    productId: l.productId,
    buyerEmail: l.buyerEmail,
    licenseKey: l.licenseKey,
    status: l.status,
    deliveredAt: l.deliveredAt,
    expiresAt: l.expiresAt ?? null,
  };
}

// ── Order reads ──────────────────────────────────────────────────────────────

/** One order by id, or null. Mirrors `.from('MarketplaceOrder').eq('id').maybeSingle()`. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const o = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return o ? toOrderRow(o) : null;
  },
});

/** One order by Stripe Checkout session id, or null. */
export const getByStripeSession = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const o = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_stripe_session', (q) => q.eq('stripeCheckoutSessionId', args.sessionId))
      .first();
    return o ? toOrderRow(o) : null;
  },
});

/** One order by Stripe PaymentIntent id, or null. */
export const getByStripePaymentIntent = query({
  args: { paymentIntentId: v.string() },
  handler: async (ctx, args) => {
    const o = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_stripe_payment_intent', (q) =>
        q.eq('stripePaymentIntentId', args.paymentIntentId),
      )
      .first();
    return o ? toOrderRow(o) : null;
  },
});

/** One order by Stripe Subscription id, or null. */
export const getByStripeSubscription = query({
  args: { subscriptionId: v.string() },
  handler: async (ctx, args) => {
    const o = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_stripe_subscription', (q) => q.eq('stripeSubscriptionId', args.subscriptionId))
      .first();
    return o ? toOrderRow(o) : null;
  },
});

/** A buyer's orders, newest-first (cap 100). The lib lowercases the email; the
 *  by_buyer_email index mirrors PG's lower(buyerEmail) index since we only ever
 *  store/query the lowercased value. */
export const listByBuyerEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_buyer_email', (q) => q.eq('buyerEmail', args.email))
      .collect();
    // PG ordered by createdAt desc, limit 100.
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.slice(0, 100).map(toOrderRow);
  },
});

/** A space's orders, newest-first (cap 200). idx_marketplace_order_space_created. */
export const listBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .take(200);
    return rows.map(toOrderRow);
  },
});

/** Most recent Stripe customer id for a buyer's subscription purchase, if any.
 *  Mirrors `.ilike(buyerEmail).not(stripeCustomerId,is,null).order(createdAt desc).limit(1)`. */
export const stripeCustomerForBuyer = query({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const rows = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_buyer_email', (q) => q.eq('buyerEmail', args.email))
      .collect();
    const withCustomer = rows.filter((r) => r.stripeCustomerId != null);
    withCustomer.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return withCustomer[0]?.stripeCustomerId ?? null;
  },
});

/** Order's (id, spaceId, buyerEmail, status) for the refund-request guard.
 *  Mirrors `.from('MarketplaceOrder').select('id, spaceId, buyerEmail, status').eq('id')`. */
export const guardFields = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const o = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!o) return null;
    return { id: o.id, spaceId: o.spaceId, buyerEmail: o.buyerEmail, status: o.status };
  },
});

/** First PAID order's (id, spaceId) for (productId, buyerEmail) — the review
 *  purchase gate. Mirrors `.eq('productId').eq('status','paid').ilike('buyerEmail').limit(1)`. */
export const paidOrderForProductBuyer = query({
  args: { productId: v.string(), buyerEmail: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_product', (q) => q.eq('productId', args.productId))
      .collect();
    const paid = rows.find(
      (o) => o.status === 'paid' && o.buyerEmail.toLowerCase() === args.buyerEmail.toLowerCase(),
    );
    return paid ? { id: paid.id, spaceId: paid.spaceId } : null;
  },
});

// ── Order writes ─────────────────────────────────────────────────────────────

/** Create a pending order. status defaults to 'pending', discountCents to 0
 *  (PG defaults the insert omitted), platformGmvFeeCents to 0. The lib already
 *  lowercases buyerEmail. Returns the OrderRow. */
export const createPending = mutation({
  args: {
    spaceId: v.string(),
    productId: v.string(),
    buyerEmail: v.string(),
    clientUserId: v.union(v.string(), v.null()),
    amountCents: v.number(),
    currency: v.string(),
    referralCode: v.union(v.string(), v.null()),
    discountCents: v.number(),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      productId: args.productId,
      buyerEmail: args.buyerEmail,
      ...(args.clientUserId !== null ? { clientUserId: args.clientUserId } : {}),
      amountCents: args.amountCents,
      currency: args.currency || 'usd',
      status: 'pending' as const,
      ...(args.referralCode !== null ? { referralCode: args.referralCode } : {}),
      discountCents: args.discountCents,
      platformGmvFeeCents: 0,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('MarketplaceOrder', doc);
    return toOrderRow(doc);
  },
});

/** Attach a Stripe id (session / payment-intent / customer / subscription) to an
 *  order. One mutation covers all four single-column updates the lib did via
 *  separate `.update().eq('id')` calls. No-op if the order vanished. */
export const attachStripe = mutation({
  args: {
    orderId: v.string(),
    stripeCheckoutSessionId: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const o = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_app_id', (q) => q.eq('id', args.orderId))
      .unique();
    if (!o) return;
    const patch: Record<string, unknown> = {};
    if (args.stripeCheckoutSessionId !== undefined)
      patch.stripeCheckoutSessionId = args.stripeCheckoutSessionId;
    if (args.stripePaymentIntentId !== undefined)
      patch.stripePaymentIntentId = args.stripePaymentIntentId;
    if (args.stripeCustomerId !== undefined) patch.stripeCustomerId = args.stripeCustomerId;
    if (args.stripeSubscriptionId !== undefined)
      patch.stripeSubscriptionId = args.stripeSubscriptionId;
    if (Object.keys(patch).length > 0) await ctx.db.patch(o._id, patch);
  },
});

/** COLA-XXXX-XXXX-XXXX-XXXX license key. Mirrors lib generateLicenseKey() so a
 *  retry inside this mutation can mint a fresh key without leaving the backend.
 *  (No node:crypto in Convex — uses Web Crypto getRandomValues.) */
function generateLicenseKey(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  const groups = [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join(''));
  return `COLA-${groups.join('-')}`;
}

export interface ClaimPendingResult {
  /** 'claimed' = this call flipped pending→paid and delivered the license (first
   *  win). 'already' = the order was already paid / lost the race (idempotent
   *  no-op). 'missing' = no such order. */
  outcome: 'claimed' | 'already' | 'missing';
  /** The order row (claimed/already). Lib uses it to drive the cross-domain work. */
  order: ReturnType<typeof toOrderRow> | null;
  /** The license key just delivered (claimed only) — for the receipt email. */
  licenseKey: string | null;
}

/**
 * The idempotent "order becomes PAID + license delivered" step, atomically.
 * Replaces markOrderPaid's CAS `.update(status=paid).eq(status=pending)` plus the
 * separate License insert.
 *
 * Returns outcome='already' (with the order) when the order is already paid or we
 * lost the pending→paid race — the lib then short-circuits the cross-domain work,
 * exactly as the old code returned early on `existing.status==='paid'` / a lost
 * CAS. Only outcome='claimed' triggers the affiliate/proceeds/email side effects.
 *
 * Uniqueness preserved: before inserting the License we check by_order (one
 * license per order, idx_license_order) — if one already exists we keep it and
 * report its key. We also re-roll the key on the rare by_license_key collision
 * (License_licenseKey_key).
 */
export const claimPending = mutation({
  args: { orderId: v.string() },
  handler: async (ctx, args): Promise<ClaimPendingResult> => {
    const o = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_app_id', (q) => q.eq('id', args.orderId))
      .unique();
    if (!o) return { outcome: 'missing', order: null, licenseKey: null };

    // Already paid (or refunded/canceled) → nothing to claim. The lib treats this
    // as the idempotent "second call" path and returns the decorated order.
    if (o.status !== 'pending') {
      return { outcome: 'already', order: toOrderRow(o), licenseKey: null };
    }

    const paidAt = new Date().toISOString();
    await ctx.db.patch(o._id, { status: 'paid', paidAt });

    // License delivery — one per order (idx_license_order UNIQUE). If a prior
    // attempt already delivered (e.g. partial retry), reuse it.
    const existingLicense = await ctx.db
      .query('License')
      .withIndex('by_order', (q) => q.eq('orderId', o.id))
      .first();
    let licenseKey: string;
    if (existingLicense) {
      licenseKey = existingLicense.licenseKey;
    } else {
      // Mint a key that doesn't collide with any existing license (global UNIQUE).
      let key = generateLicenseKey();
      let guard = 0;
      while (
        guard++ < 5 &&
        (await ctx.db
          .query('License')
          .withIndex('by_license_key', (q) => q.eq('licenseKey', key))
          .first())
      ) {
        key = generateLicenseKey();
      }
      licenseKey = key;
      await ctx.db.insert('License', {
        id: crypto.randomUUID(),
        orderId: o.id,
        productId: o.productId,
        buyerEmail: o.buyerEmail,
        licenseKey,
        status: 'active',
        deliveredAt: new Date().toISOString(),
      });
    }

    const updated = (await ctx.db.get(o._id))!;
    return { outcome: 'claimed', order: toOrderRow(updated), licenseKey };
  },
});

/**
 * Record the computed seller proceeds on a paid order. Replaces the final
 * `.update({ sellerPayoutCents, platformGmvFeeCents, sellerTransferId? }).eq('id')`
 * in markOrderPaid. The cents were computed in lib (GROSS amount − gross
 * commission − GMV fee) and are stored verbatim — never recomputed here.
 */
export const recordSellerProceeds = mutation({
  args: {
    orderId: v.string(),
    sellerPayoutCents: v.number(),
    platformGmvFeeCents: v.number(),
    sellerTransferId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<void> => {
    const o = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_app_id', (q) => q.eq('id', args.orderId))
      .unique();
    if (!o) return;
    await ctx.db.patch(o._id, {
      sellerPayoutCents: args.sellerPayoutCents,
      platformGmvFeeCents: args.platformGmvFeeCents,
      ...(args.sellerTransferId !== null ? { sellerTransferId: args.sellerTransferId } : {}),
    });
  },
});

export interface MarkRefundedResult {
  /** 'refunded' = this call flipped paid→refunded + revoked the license (first
   *  win, lib then claws back commissions + emails). 'noop' = already refunded /
   *  never paid. 'missing' = no such order. */
  outcome: 'refunded' | 'noop' | 'missing';
  order: ReturnType<typeof toOrderRow> | null;
}

/**
 * The idempotent refund step: CAS paid→refunded AND revoke the active license, in
 * ONE mutation. Replaces markOrderRefunded's `.update(status=refunded).eq(status=paid)`
 * plus the separate `.from('License').update(status=revoked).eq(orderId).eq(status=active)`.
 *
 * Only outcome='refunded' tells the lib to call reverseCommissionsForOrder
 * (affiliates → Supabase) and send the refund email — exactly the old early-return
 * on a lost/empty CAS.
 */
export const markRefunded = mutation({
  args: { orderId: v.string() },
  handler: async (ctx, args): Promise<MarkRefundedResult> => {
    const o = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_app_id', (q) => q.eq('id', args.orderId))
      .unique();
    if (!o) return { outcome: 'missing', order: null };
    if (o.status !== 'paid') {
      // Already refunded or never paid → no-op (return the current row).
      return { outcome: 'noop', order: toOrderRow(o) };
    }

    await ctx.db.patch(o._id, { status: 'refunded', refundedAt: new Date().toISOString() });

    // Revoke the active license (status='active' → 'revoked'); leave already-
    // revoked/expired ones untouched, matching the `.eq('status','active')` filter.
    const licenses = await ctx.db
      .query('License')
      .withIndex('by_order', (q) => q.eq('orderId', o.id))
      .collect();
    for (const l of licenses) {
      if (l.status === 'active') await ctx.db.patch(l._id, { status: 'revoked' });
    }

    const updated = (await ctx.db.get(o._id))!;
    return { outcome: 'refunded', order: toOrderRow(updated) };
  },
});

// ── License reads ────────────────────────────────────────────────────────────

/** A buyer's licenses, newest-delivered first (cap 100). The lib lowercases the
 *  email; by_buyer_email mirrors PG's lower(buyerEmail) index. */
export const licensesByBuyerEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('License')
      .withIndex('by_buyer_email', (q) => q.eq('buyerEmail', args.email))
      .collect();
    rows.sort((a, b) => (a.deliveredAt < b.deliveredAt ? 1 : a.deliveredAt > b.deliveredAt ? -1 : 0));
    return rows.slice(0, 100).map(toLicenseRow);
  },
});

/** The license for an order (one per order), or null. */
export const licenseForOrder = query({
  args: { orderId: v.string() },
  handler: async (ctx, args) => {
    const l = await ctx.db
      .query('License')
      .withIndex('by_order', (q) => q.eq('orderId', args.orderId))
      .first();
    return l ? toLicenseRow(l) : null;
  },
});

// ── Aggregates (admin metrics) ───────────────────────────────────────────────

/** Sum of GROSS amountCents over a space's PAID orders since `since` (ISO).
 *  Mirrors `.select('amountCents').eq('spaceId').eq('status','paid').gte('paidAt', since)`.
 *  Returns the rows so the caller can aggregate exactly as before (no recompute). */
export const paidAmountsForSpaceSince = query({
  args: { spaceId: v.string(), since: v.string() },
  handler: async (ctx, args): Promise<number[]> => {
    const rows = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows
      .filter((o) => o.status === 'paid' && o.paidAt != null && o.paidAt >= args.since)
      .map((o) => o.amountCents);
  },
});

/** Lets admin-metrics fetch orders by (status, paidAt window) across all spaces.
 *  No PG index on status alone existed; admin-metrics scanned. We expose a typed
 *  read returning the minimal columns it folds. `status` optional → all. */
export const ordersForMetrics = query({
  args: {
    status: v.optional(orderStatusValidator),
    paidSince: v.optional(v.string()),
    createdSince: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows: Doc<'MarketplaceOrder'>[] = await ctx.db.query('MarketplaceOrder').collect();
    return rows
      .filter((o) => (args.status === undefined ? true : o.status === args.status))
      .filter((o) => (args.paidSince === undefined ? true : o.paidAt != null && o.paidAt >= args.paidSince!))
      .filter((o) =>
        args.createdSince === undefined ? true : o.createdAt >= args.createdSince!,
      )
      .map((o) => ({
        id: o.id,
        spaceId: o.spaceId,
        amountCents: o.amountCents,
        platformGmvFeeCents: o.platformGmvFeeCents,
        status: o.status,
        createdAt: o.createdAt,
        paidAt: o.paidAt ?? null,
      }));
  },
});
