import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * Review data access — the Convex replacement for the `.from('Review')` reads &
 * writes in lib/marketplace/reviews.ts.
 *
 * The purchase gate (a PAID MarketplaceOrder for (productId, buyerEmail)) and the
 * email masking stay in lib; the order lookup is itself a Convex query
 * (marketplace.orders.paidOrderForProductBuyer) the lib calls before insert. This
 * module owns only the Review table hops.
 *
 * UNIQUE(productId, lower(buyerEmail)) — one review per buyer per product — is
 * re-implemented as a read-then-insert inside `create`: we scan by_product_buyer
 * for an existing review by the (lowercased) buyer and refuse with a 409-style
 * result instead of inserting a duplicate. Money never appears here.
 *
 * Product names for the moderation queue come from a separate Product read
 * (marketplace.products.namesByIds) the lib joins in — Product is this domain's
 * table too, but the join lives in lib to keep each query single-table.
 */

const statusValidator = v.union(v.literal('published'), v.literal('hidden'));

export interface CreateReviewResult {
  ok: boolean;
  /** 'duplicate' when the buyer already reviewed this product (→ lib maps to 409). */
  error?: 'duplicate';
}

/**
 * Insert a review (the caller already verified the paid order + sanitised
 * title/body + lowercased buyerEmail + validated rating). Enforces one-review-per
 * (productId, lower(buyerEmail)) by reading first. status defaults to 'published'
 * (PG default). spaceId is the order's spaceId the lib passes (never client-set).
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    productId: v.string(),
    buyerEmail: v.string(), // already lowercased by lib
    rating: v.number(),
    title: v.union(v.string(), v.null()),
    body: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<CreateReviewResult> => {
    // UNIQUE(productId, lower(buyerEmail)) backstop. by_product_buyer is
    // (productId, buyerEmail); we store the lowercased email so the eq matches
    // PG's lower() index exactly.
    const existing = await ctx.db
      .query('Review')
      .withIndex('by_product_buyer', (q) =>
        q.eq('productId', args.productId).eq('buyerEmail', args.buyerEmail),
      )
      .first();
    if (existing) return { ok: false, error: 'duplicate' };

    await ctx.db.insert('Review', {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      productId: args.productId,
      buyerEmail: args.buyerEmail,
      rating: args.rating,
      ...(args.title !== null ? { title: args.title } : {}),
      ...(args.body !== null ? { body: args.body } : {}),
      status: 'published',
      createdAt: new Date().toISOString(),
    });
    return { ok: true };
  },
});

/**
 * Published reviews for a product, newest-first (cap 100). Returns the raw fields
 * the lib maps (it masks buyerEmail into the public author handle). Replaces
 * `.select('id, rating, title, body, createdAt, buyerEmail').eq('productId')
 *  .eq('status','published').order('createdAt', desc).limit(100)`.
 */
export const publishedForProduct = query({
  args: { productId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Review')
      .withIndex('by_product_status', (q) =>
        q.eq('productId', args.productId).eq('status', 'published'),
      )
      .order('desc')
      .take(100);
    return rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      title: r.title ?? null,
      body: r.body ?? null,
      createdAt: r.createdAt,
      buyerEmail: r.buyerEmail,
    }));
  },
});

/**
 * Published (productId, rating) pairs for a set of products — the batched rating
 * aggregate input. The lib folds these into avg/count (so the rounding stays in
 * the unit-tested lib). Replaces `.select('productId, rating').in('productId', ids)
 * .eq('status','published')`. One indexed read per product id, concatenated.
 */
export const publishedRatingsForProducts = query({
  args: { productIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: { productId: string; rating: number }[] = [];
    const seen = new Set<string>();
    for (const pid of args.productIds) {
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      const rows = await ctx.db
        .query('Review')
        .withIndex('by_product_status', (q) => q.eq('productId', pid).eq('status', 'published'))
        .collect();
      for (const r of rows) out.push({ productId: r.productId, rating: r.rating });
    }
    return out;
  },
});

/** Admin: set a review's status by id (hide / unhide). Returns whether it existed.
 *  Replaces `.update({ status }).eq('id')`. */
export const setStatus = mutation({
  args: { id: v.string(), status: statusValidator },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const r = await ctx.db
      .query('Review')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r) return { ok: false };
    await ctx.db.patch(r._id, { status: args.status });
    return { ok: true };
  },
});

/**
 * Admin moderation queue: recent reviews across all sellers, newest-first
 * (cap = limit). Returns the raw fields the lib decorates with product names.
 * Replaces `.select(...).order('createdAt', desc).limit(limit)` (full-table, no
 * per-product/status filter — it's the cross-seller admin view).
 */
export const forModeration = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query('Review').order('desc').take(args.limit);
    return rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      spaceId: r.spaceId,
      buyerEmail: r.buyerEmail,
      rating: r.rating,
      title: r.title ?? null,
      body: r.body ?? null,
      status: r.status,
      createdAt: r.createdAt,
    }));
  },
});
