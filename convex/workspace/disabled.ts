import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * DisabledSpace data access — the Convex replacement for the three
 * `.from('DisabledSpace')` ops in lib/agent/kill-switch.ts (the agent kill-switch).
 *
 * The lib keeps its 30-second in-process TTL cache and the assertSpaceEnabled
 * wrapper — those are pure app logic, not DB hops. Only the table reads/writes
 * move here:
 *   - isDisabled(spaceId)  → `SELECT id WHERE spaceId AND isActive=true LIMIT 1`.
 *   - disable(spaceId,…)   → the PG `.upsert(onConflict:'spaceId,isActive')`.
 *   - reenable(spaceId)    → `UPDATE isActive=false, reenabledAt=now() WHERE
 *                             spaceId AND isActive=true`.
 *
 * UNIQUE(spaceId) WHERE isActive=true (one ACTIVE disable per space) is preserved
 * by disable() reading the active row first, then patching it (or inserting a new
 * active one) inside one serializable mutation — no second active row can appear.
 */

/** True when the space has an active disable. Mirrors isSpaceDisabled's
 *  `.eq('spaceId', spaceId).eq('isActive', true).limit(1).maybeSingle()` !== null. */
export const isDisabled = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query('DisabledSpace')
      .withIndex('by_space_active', (q) => q.eq('spaceId', args.spaceId).eq('isActive', true))
      .first();
    return row !== null;
  },
});

/**
 * Disable a space (or refresh an existing active disable). Mirrors disableSpace's
 * `.upsert({ spaceId, reason, disabledBy, isActive: true, reenabledAt: null },
 * { onConflict: 'spaceId,isActive' })`.
 *
 * Read-then-patch-or-insert in one mutation preserves "one active disable per
 * space" (the PG partial-unique index). If an active row exists we patch its
 * reason/disabledBy and clear reenabledAt; otherwise we insert a fresh active row.
 */
export const disable = mutation({
  args: { spaceId: v.string(), reason: v.string(), disabledBy: v.optional(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    const disabledBy = args.disabledBy ?? 'system';
    const active = await ctx.db
      .query('DisabledSpace')
      .withIndex('by_space_active', (q) => q.eq('spaceId', args.spaceId).eq('isActive', true))
      .first();
    if (active) {
      await ctx.db.patch(active._id, {
        reason: args.reason,
        disabledBy,
        reenabledAt: undefined, // clears the column (was set null in the upsert)
      });
      return;
    }
    await ctx.db.insert('DisabledSpace', {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      reason: args.reason,
      disabledBy,
      isActive: true,
      disabledAt: new Date().toISOString(),
    });
  },
});

/** Re-enable a space: flip every active disable to inactive + stamp reenabledAt.
 *  Mirrors reenableSpace's `.update({ isActive:false, reenabledAt:now() })
 *  .eq('spaceId', spaceId).eq('isActive', true)`. No-op when none are active. */
export const reenable = mutation({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const active = await ctx.db
      .query('DisabledSpace')
      .withIndex('by_space_active', (q) => q.eq('spaceId', args.spaceId).eq('isActive', true))
      .collect();
    const now = new Date().toISOString();
    for (const row of active) {
      await ctx.db.patch(row._id, { isActive: false, reenabledAt: now });
    }
  },
});
