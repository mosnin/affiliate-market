import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ProductView data access — the Convex replacement for the `.from('ProductView')`
 * reads & writes in lib/marketplace/views.ts.
 *
 * recordProductView first resolves the owning spaceId from Product (itself a
 * Convex read, marketplace.products.spaceForProduct) then inserts here. The
 * best-effort/never-throw contract stays in lib. Money note: views feed a
 * SELLER-facing funnel → GROSS only; no creator net here.
 *
 * This table has no uniqueness constraint — it's an append-only beacon.
 */

/** Append one product-view row. The lib already resolved spaceId (nullable) and
 *  truncated visitorId; we just write. createdAt = now (PG default). */
export const record = mutation({
  args: {
    productId: v.string(),
    spaceId: v.union(v.string(), v.null()),
    visitorId: v.union(v.string(), v.null()),
    ipHash: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('ProductView', {
      id: crypto.randomUUID(),
      productId: args.productId,
      ...(args.spaceId !== null ? { spaceId: args.spaceId } : {}),
      ...(args.visitorId !== null ? { visitorId: args.visitorId } : {}),
      ...(args.ipHash !== null ? { ipHash: args.ipHash } : {}),
      createdAt: new Date().toISOString(),
    });
  },
});

/**
 * Total views per product for a set of ids, as { productId, count } rows the lib
 * folds into its Map. Replaces `.select('productId').in('productId', ids)` +
 * in-memory tally — but tallied here so we don't ship every thin row over the
 * wire. One indexed read per id (by_product_created), counted.
 */
export const countsForProducts = query({
  args: { productIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: { productId: string; count: number }[] = [];
    const seen = new Set<string>();
    for (const pid of args.productIds) {
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      const rows = await ctx.db
        .query('ProductView')
        .withIndex('by_product_created', (q) => q.eq('productId', pid))
        .collect();
      if (rows.length > 0) out.push({ productId: pid, count: rows.length });
    }
    return out;
  },
});
