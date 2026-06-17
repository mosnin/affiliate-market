import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * SwarmRun data access — Convex replacement for every `.from('SwarmRun')` call:
 *   - app/api/swarm/route.ts (GET list, POST create)
 *   - app/api/swarm/[runId]/route.ts (GET one + members)
 *   - app/api/swarm/[runId]/cancel/route.ts (read + mark cancelled)
 *   - app/api/swarm/[runId]/stream/route.ts (read status)
 *   - app/s/[slug]/swarm/page.tsx (list, limit 10)
 *   - app/s/[slug]/swarm/[runId]/page.tsx (read one)
 *   - lib/ai-tools/tools/delegate-task.ts (create, returns id)
 *
 * The Modal swarm runner (Python) also writes SwarmRun (status/plan/result/
 * cost transitions). Those writes are NOT in this TS codebase, so no mutation
 * is provided for them yet; `patch` below is the generic transition mutation the
 * integrator can point the runner at when it moves to Convex.
 */

type SwarmRunDoc = {
  id: string;
  spaceId: string;
  goal: string;
  status: 'queued' | 'planning' | 'running' | 'auditing' | 'completed' | 'failed' | 'cancelled';
  plan?: unknown;
  result?: string;
  errorMessage?: string;
  totalCostCents: number;
  createdAt: string;
  completedAt?: string;
};

/** Map a Convex doc to the legacy SwarmRun row (drop _id/_creationTime, surface
 *  `id`, coerce absent optionals -> null so `select('*')` callers see SQL NULLs). */
function toRow(d: SwarmRunDoc) {
  return {
    id: d.id,
    spaceId: d.spaceId,
    goal: d.goal,
    status: d.status,
    plan: d.plan ?? null,
    result: d.result ?? null,
    errorMessage: d.errorMessage ?? null,
    totalCostCents: d.totalCostCents,
    createdAt: d.createdAt,
    completedAt: d.completedAt ?? null,
  };
}

const STATUS = v.union(
  v.literal('queued'),
  v.literal('planning'),
  v.literal('running'),
  v.literal('auditing'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('cancelled'),
);

// ── Reads ────────────────────────────────────────────────────────────────────

/** One run by id (full row) or null. Callers that also need a spaceId guard
 *  (every route) pass spaceId and compare; getByIdInSpace does it for them. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('SwarmRun')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return d ? toRow(d) : null;
  },
});

/** One run by id, scoped to a space (full row) or null. Mirrors the routes'
 *  `.eq('id').eq('spaceId').maybeSingle()` / `run.spaceId !== space.id` guard. */
export const getByIdInSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('SwarmRun')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d || d.spaceId !== args.spaceId) return null;
    return toRow(d);
  },
});

/** A space's runs, newest-first, capped (default 20 — the API list cap; the
 *  swarm page passes 10). Replaces `.eq('spaceId').order(createdAt desc).limit(n)`. */
export const listForSpace = query({
  args: { spaceId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('SwarmRun')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .take(args.limit ?? 20);
    return rows.map(toRow);
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create a run. spaceId + goal required; status defaults to 'queued' (the only
 * status any TS caller inserts). totalCostCents defaults to 0 (PG default).
 * Returns the full row so callers can read `run.id` (delegate-task, both POSTs).
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    goal: v.string(),
    status: v.optional(STATUS),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await ctx.db.insert('SwarmRun', {
      id,
      spaceId: args.spaceId,
      goal: args.goal,
      status: args.status ?? 'queued',
      totalCostCents: 0,
      createdAt: now,
    });
    const stored = await ctx.db
      .query('SwarmRun')
      .withIndex('by_app_id', (q) => q.eq('id', id))
      .unique();
    return toRow(stored!);
  },
});

/**
 * Cancel a run: only when its status is currently cancellable
 * (queued/planning/running/auditing). Sets status='cancelled' + completedAt.
 * Returns { ok, status } so the route can distinguish 404 (not found) /
 * 400 (not cancellable) / success — the single read-then-write the cancel route
 * did across two statements, now atomic. (spaceId guard applied by the caller
 * which passes the already-verified run, or pass spaceId to gate here.)
 */
export const cancel = mutation({
  args: { id: v.string(), spaceId: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'not_cancellable' }> => {
    const d = await ctx.db
      .query('SwarmRun')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d || (args.spaceId !== undefined && d.spaceId !== args.spaceId)) {
      return { ok: false, reason: 'not_found' };
    }
    const CANCELLABLE = new Set(['queued', 'planning', 'running', 'auditing']);
    if (!CANCELLABLE.has(d.status)) return { ok: false, reason: 'not_cancellable' };
    await ctx.db.patch(d._id, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    });
    return { ok: true };
  },
});

/**
 * Generic status/progress transition for the run (the Modal runner's writes:
 * planning -> running -> auditing -> completed/failed, plan/result/cost). Only
 * provided fields change. Not wired to a TS call site today (the runner is
 * Python); provided so the integrator has the write when it cuts over. Returns
 * the full row or null when the id is unknown.
 */
export const patch = mutation({
  args: {
    id: v.string(),
    status: v.optional(STATUS),
    plan: v.optional(v.any()),
    result: v.optional(v.union(v.string(), v.null())),
    errorMessage: v.optional(v.union(v.string(), v.null())),
    totalCostCents: v.optional(v.number()),
    completedAt: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('SwarmRun')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d) return null;
    const patchObj: Record<string, unknown> = {};
    if (args.status !== undefined) patchObj.status = args.status;
    if (args.plan !== undefined) patchObj.plan = args.plan;
    if (args.result !== undefined) patchObj.result = args.result === null ? undefined : args.result;
    if (args.errorMessage !== undefined)
      patchObj.errorMessage = args.errorMessage === null ? undefined : args.errorMessage;
    if (args.totalCostCents !== undefined) patchObj.totalCostCents = args.totalCostCents;
    if (args.completedAt !== undefined)
      patchObj.completedAt = args.completedAt === null ? undefined : args.completedAt;
    await ctx.db.patch(d._id, patchObj);
    return toRow((await ctx.db.get(d._id))!);
  },
});
