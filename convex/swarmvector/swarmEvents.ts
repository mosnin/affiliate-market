import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * SwarmEvent data access — Convex replacement for `.from('SwarmEvent')`:
 *   - app/api/swarm/[runId]/stream/route.ts (poll a run's events created after a
 *     cursor, oldest-first, limit 50 — the SSE pump)
 *   - app/api/swarm/[runId]/cancel/route.ts (append a swarm_cancelled event)
 *
 * The Modal runner also appends progress events; `append` here is the same
 * insert the runner needs when it cuts over to Convex.
 */

type SwarmEventDoc = {
  id: string;
  swarmRunId: string;
  memberId?: string;
  type: string;
  data: unknown;
  createdAt: string;
};

/** Map a Convex doc to the legacy SwarmEvent row (drop _id/_creationTime,
 *  surface `id`, coerce absent memberId -> null, data defaults to {}). */
function toRow(d: SwarmEventDoc) {
  return {
    id: d.id,
    swarmRunId: d.swarmRunId,
    memberId: d.memberId ?? null,
    type: d.type,
    data: d.data ?? {},
    createdAt: d.createdAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Events for a run created strictly after `afterCreatedAt`, oldest-first, capped
 * (default 50 — the stream's page size). Mirrors the SSE pump's
 * `.eq('swarmRunId').gt('createdAt', cursor).order(createdAt asc).limit(50)`.
 * Pass the empty-cursor sentinel new Date(0).toISOString() for the first poll
 * (the route does); `afterCreatedAt` omitted == from the beginning.
 */
export const listForRunAfter = query({
  args: {
    swarmRunId: v.string(),
    afterCreatedAt: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const cursor = args.afterCreatedAt ?? '';
    const rows = await ctx.db
      .query('SwarmEvent')
      .withIndex('by_run_created', (q) =>
        cursor
          ? q.eq('swarmRunId', args.swarmRunId).gt('createdAt', cursor)
          : q.eq('swarmRunId', args.swarmRunId),
      )
      .order('asc')
      .take(args.limit ?? 50);
    return rows.map(toRow);
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Append an event. `data` defaults to {} (PG default). memberId optional.
 * Covers the cancel route's swarm_cancelled append and the runner's progress
 * events. Returns the full row.
 */
export const append = mutation({
  args: {
    swarmRunId: v.string(),
    type: v.string(),
    data: v.optional(v.any()),
    memberId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const data = args.data ?? {};
    await ctx.db.insert('SwarmEvent', {
      id,
      swarmRunId: args.swarmRunId,
      type: args.type,
      data,
      memberId: args.memberId,
      createdAt: now,
    });
    // We minted id + now, so we can return the row shape directly — no re-read.
    return toRow({
      id,
      swarmRunId: args.swarmRunId,
      memberId: args.memberId,
      type: args.type,
      data,
      createdAt: now,
    });
  },
});
