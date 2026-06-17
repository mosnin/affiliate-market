import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * StripeBridge data access — the Convex replacement for `.from('StripeBridge')`
 * in lib/affiliates/stripe-bridge.ts. One bridge row per space (UNIQUE spaceId):
 * the seller↔Stripe webhook bridge. Secret encryption/decryption + all event
 * processing stay in lib (pure crypto + Stripe SDK); these are just the row hops.
 *
 * The bridge stores no Stripe account id — attribution is by webhook signature +
 * event metadata (handled in lib). Columns: id, spaceId, webhookSecretEnc,
 * lastEventAt, createdAt.
 */

type BridgeFields = {
  id: string;
  spaceId: string;
  webhookSecretEnc?: string;
  lastEventAt?: string;
  createdAt: string;
};

/** The StripeBridgeRow shape lib consumes; optionals -> null. */
function toBridgeRow(b: BridgeFields) {
  return {
    id: b.id,
    spaceId: b.spaceId,
    webhookSecretEnc: b.webhookSecretEnc ?? null,
    lastEventAt: b.lastEventAt ?? null,
    createdAt: b.createdAt,
  };
}

/** getBridgeForSpace(): the space's bridge, or null. Mirrors
 *  `.select('*').eq('spaceId', spaceId).maybeSingle()`. */
export const getForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const b = await ctx.db
      .query('StripeBridge')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    return b ? toBridgeRow(b) : null;
  },
});

/** getBridgeById(): a bridge by id (webhook route resolves the bridge from the
 *  URL). Mirrors `.select('*').eq('id', bridgeId).maybeSingle()`. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const b = await ctx.db
      .query('StripeBridge')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return b ? toBridgeRow(b) : null;
  },
});

/** getOrCreateBridge(): return the space's bridge, creating it if absent. The
 *  old lib did insert-then-fallback-to-read on the UNIQUE(spaceId) conflict;
 *  this folds it into ONE serializable read-then-insert (race-safe, no conflict
 *  dance). Mirrors the net effect — always returns the single bridge row. */
export const getOrCreate = mutation({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('StripeBridge')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    if (existing) return toBridgeRow(existing);
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('StripeBridge', doc);
    return toBridgeRow(doc);
  },
});

/** setBridgeSecret(): store the encrypted webhook signing secret on a bridge by
 *  id. Mirrors `.update({ webhookSecretEnc: enc }).eq('id', bridgeId)`. The lib
 *  encrypts the secret before calling. Returns true on success (lib returns
 *  `!error`); false if the bridge vanished. */
export const setSecret = mutation({
  args: { id: v.string(), webhookSecretEnc: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const b = await ctx.db
      .query('StripeBridge')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!b) return false;
    await ctx.db.patch(b._id, { webhookSecretEnc: args.webhookSecretEnc });
    return true;
  },
});

/** Bump lastEventAt on a bridge by id (fire-and-forget on every verified webhook
 *  event). Mirrors `.update({ lastEventAt: now }).eq('id', bridge.id)`. */
export const touchLastEvent = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const b = await ctx.db
      .query('StripeBridge')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (b) await ctx.db.patch(b._id, { lastEventAt: new Date().toISOString() });
  },
});
