import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * TelemetryEvent data access — the Convex replacement for `.from('TelemetryEvent')`
 * in lib/telemetry.ts (emit / hasEmitted / getFirstEmittedAt) and the
 * account-deletion sweep. Append-mostly first-value analytics. All callers
 * swallow errors and never gate user flow on the result — that posture stays
 * in lib; these just do the table hops.
 */

/** emit(): insert one telemetry row. Mirrors lib/telemetry.ts#emit's
 *  `.insert({ id, spaceId, userId, event, payload })`. payload defaults to {}.
 *  spaceId/userId are nullable. */
export const emit = mutation({
  args: {
    spaceId: v.union(v.string(), v.null()),
    userId: v.union(v.string(), v.null()),
    event: v.string(),
    payload: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('TelemetryEvent', {
      id: crypto.randomUUID(),
      ...(args.spaceId !== null ? { spaceId: args.spaceId } : {}),
      ...(args.userId !== null ? { userId: args.userId } : {}),
      event: args.event,
      payload: args.payload ?? {},
      createdAt: new Date().toISOString(),
    });
  },
});

/** hasEmitted(): has this space ever recorded `event`? Mirrors the count query
 *  `.select('id', { count: 'exact', head: true }).eq('spaceId').eq('event')`.
 *  Returns a boolean (the lib returns count>0). */
export const hasEmitted = query({
  args: { spaceId: v.string(), event: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query('TelemetryEvent')
      .withIndex('by_space_event', (q) => q.eq('spaceId', args.spaceId).eq('event', args.event))
      .first();
    return row !== null;
  },
});

/** getFirstEmittedAt(): the earliest createdAt for (space, event), or null.
 *  Mirrors `.select('createdAt').eq('spaceId').eq('event').order(createdAt asc)
 *  .limit(1).maybeSingle()`. Returns the ISO string; the lib parses it to Date. */
export const firstEmittedAt = query({
  args: { spaceId: v.string(), event: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const rows = await ctx.db
      .query('TelemetryEvent')
      .withIndex('by_space_event', (q) => q.eq('spaceId', args.spaceId).eq('event', args.event))
      .collect();
    if (rows.length === 0) return null;
    let earliest = rows[0].createdAt;
    for (const r of rows) if (r.createdAt < earliest) earliest = r.createdAt;
    return earliest;
  },
});

/** Account-deletion sweep: hard-delete every telemetry row for a space. Mirrors
 *  `.from('TelemetryEvent').delete().eq('spaceId', spaceId)`. Returns the count. */
export const deleteForSpace = mutation({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('TelemetryEvent')
      .withIndex('by_space_event', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  },
});
