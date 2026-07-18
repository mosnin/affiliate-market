import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ProductPacket data access — the Convex replacement for the `.from('ProductPacket')`
 * reads & writes in the packet routes and the public packet page.
 *
 * Packet routes also touch Product (ownership resolve) and DealDocument (doc
 * validation) — both stay where they belong: the Product resolve becomes a
 * marketplace.products.getByIdInSpace call, DealDocument stays on Supabase. This
 * module owns only the ProductPacket hops. Auth/scope/doc-validation stay in the
 * routes.
 *
 * ProductPacket_token_key UNIQUE(token): the token is minted by the route with
 * 32 bytes of entropy (collision-free in practice); `create` reads by_token once
 * before insert as the cheap backstop the unique index used to provide.
 */

type PacketFields = {
  id: string;
  spaceId: string;
  productId: string;
  name: string;
  token: string;
  includeDocumentIds: unknown;
  expiresAt?: string;
  viewCount: number;
  lastViewedAt?: string;
  createdAt: string;
  revokedAt?: string;
};

/** The full legacy ProductPacket row. Surfaces id, coerces absent optionals to
 *  SQL NULL; includeDocumentIds defaults to [] (PG default, never NULL). */
function toRow(p: PacketFields) {
  return {
    id: p.id,
    spaceId: p.spaceId,
    productId: p.productId,
    name: p.name,
    token: p.token,
    includeDocumentIds: Array.isArray(p.includeDocumentIds) ? p.includeDocumentIds : [],
    expiresAt: p.expiresAt ?? null,
    viewCount: p.viewCount,
    lastViewedAt: p.lastViewedAt ?? null,
    createdAt: p.createdAt,
    revokedAt: p.revokedAt ?? null,
  };
}

/** A product's packets (scoped to a space), newest-first. Replaces
 *  `.eq('productId').eq('spaceId').order('createdAt', desc)`. by_product_created
 *  is (productId, createdAt); we filter spaceId in memory (route already owns the
 *  space). */
export const listForProductInSpace = query({
  args: { productId: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ProductPacket')
      .withIndex('by_product_created', (q) => q.eq('productId', args.productId))
      .order('desc')
      .collect();
    return rows.filter((r) => r.spaceId === args.spaceId).map(toRow);
  },
});

/** One packet by id, scoped to (productId, spaceId) or just spaceId. Mirrors the
 *  two route `resolve()` helpers: the [packetId] route scopes by id+productId+
 *  spaceId; the simpler one by id+spaceId. productId optional. Returns the row
 *  or null. */
export const getByIdScoped = query({
  args: { id: v.string(), spaceId: v.string(), productId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('ProductPacket')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p || p.spaceId !== args.spaceId) return null;
    if (args.productId !== undefined && p.productId !== args.productId) return null;
    return toRow(p);
  },
});

/** One packet by its public token, or null. Used by the public packet page +
 *  documents endpoint (no auth — gated by token/expiry/revoked). */
export const getByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('ProductPacket')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .first();
    return p ? toRow(p) : null;
  },
});

/**
 * Create a packet. The route mints id + token and validated includeDocumentIds +
 * resolved expiresAt (null = permanent). viewCount starts 0. Enforces token
 * uniqueness (read-then-insert). Returns the full row.
 */
export const create = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    productId: v.string(),
    name: v.string(),
    token: v.string(),
    includeDocumentIds: v.any(),
    expiresAt: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('ProductPacket')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .first();
    // Token collision is astronomically unlikely; surface as an error rather than
    // silently returning a foreign packet (the route would 500, like PG 23505).
    if (existing) throw new Error('ProductPacket token collision');

    const doc = {
      id: args.id,
      spaceId: args.spaceId,
      productId: args.productId,
      name: args.name,
      token: args.token,
      includeDocumentIds: Array.isArray(args.includeDocumentIds) ? args.includeDocumentIds : [],
      viewCount: 0,
      ...(args.expiresAt !== null ? { expiresAt: args.expiresAt } : {}),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('ProductPacket', doc);
    return toRow(doc);
  },
});

/**
 * Update a packet by id, scoped to a space. Handles the route's tri-state fields:
 *   - revoked true → set revokedAt now; false → clear it.
 *   - name → set (validated upstream).
 *   - expiresAt: undefined leave / null clear / string set.
 * Returns the full row, or null (route → 404 / no-op). Replaces
 * `.update(patch).eq('id').eq('spaceId')`.
 */
export const update = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    revoked: v.optional(v.boolean()),
    name: v.optional(v.string()),
    // tri-state: undefined leave, null clear, string set
    expiresAt: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('ProductPacket')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p || p.spaceId !== args.spaceId) return null;

    const patch: Record<string, unknown> = {};
    if (args.revoked === true) patch.revokedAt = new Date().toISOString();
    if (args.revoked === false) patch.revokedAt = undefined; // clear
    if (args.name !== undefined) patch.name = args.name;
    if (args.expiresAt !== undefined) {
      patch.expiresAt = args.expiresAt === null ? undefined : args.expiresAt;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(p._id, patch);
    return toRow((await ctx.db.get(p._id))!);
  },
});

/** Delete a packet by id, scoped to a space. Returns whether it existed. Replaces
 *  `.delete().eq('id').eq('spaceId')`. */
export const remove = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    const p = await ctx.db
      .query('ProductPacket')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p || p.spaceId !== args.spaceId) return { deleted: false };
    await ctx.db.delete(p._id);
    return { deleted: true };
  },
});

/** Best-effort view bump on the public packet page: increment viewCount + stamp
 *  lastViewedAt. No-op if the packet vanished. Replaces the page's
 *  `.update({ viewCount: viewCount+1, lastViewedAt }).eq('id')`. */
export const bumpView = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const p = await ctx.db
      .query('ProductPacket')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p) return;
    await ctx.db.patch(p._id, {
      viewCount: (p.viewCount ?? 0) + 1,
      lastViewedAt: new Date().toISOString(),
    });
  },
});
