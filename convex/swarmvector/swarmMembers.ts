import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * SwarmMember data access — Convex replacement for `.from('SwarmMember')`:
 *   - app/api/swarm/[runId]/route.ts (list members for a run, unordered)
 *   - app/s/[slug]/swarm/[runId]/page.tsx (list members, ordered by wave asc)
 *
 * Both reads are "all members of one run." The detail page orders by wave asc;
 * the API route doesn't — so `listForRun` orders by (wave asc, createdAt asc),
 * a superset that satisfies both (the route doesn't depend on order).
 *
 * Member WRITES (create on planning, status/output/cost transitions) are done by
 * the Python Modal runner, not this TS codebase — so `create` / `patch` here are
 * for the integrator's runner cutover, not a current call site. They are modelled
 * faithfully so they're ready.
 */

type SwarmMemberDoc = {
  id: string;
  swarmRunId: string;
  customAgentId?: string;
  name: string;
  role?: string;
  systemPrompt: string;
  task: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  output?: string;
  wave: number;
  costCents: number;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
};

/** Map a Convex doc to the legacy SwarmMember row (drop _id/_creationTime,
 *  surface `id`, coerce absent optionals -> null). */
function toRow(d: SwarmMemberDoc) {
  return {
    id: d.id,
    swarmRunId: d.swarmRunId,
    customAgentId: d.customAgentId ?? null,
    name: d.name,
    role: d.role ?? null,
    systemPrompt: d.systemPrompt,
    task: d.task,
    status: d.status,
    output: d.output ?? null,
    wave: d.wave,
    costCents: d.costCents,
    startedAt: d.startedAt ?? null,
    completedAt: d.completedAt ?? null,
    createdAt: d.createdAt,
  };
}

const STATUS = v.union(
  v.literal('queued'),
  v.literal('running'),
  v.literal('completed'),
  v.literal('failed'),
);

// ── Reads ────────────────────────────────────────────────────────────────────

/** All members of a run, ordered by wave asc then createdAt asc. Serves both the
 *  detail page (wave asc) and the API route (order-agnostic). */
export const listForRun = query({
  args: { swarmRunId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('SwarmMember')
      .withIndex('by_run', (q) => q.eq('swarmRunId', args.swarmRunId))
      .collect();
    rows.sort((a, b) => {
      if (a.wave !== b.wave) return a.wave - b.wave;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });
    return rows.map(toRow);
  },
});

/** One member by id (full row) or null. For the runner's per-member updates. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('SwarmMember')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return d ? toRow(d) : null;
  },
});

// ── Writes (runner cutover — no current TS call site) ─────────────────────────

/** Insert a member. Defaults match PG: systemPrompt '', status 'queued', wave 1,
 *  costCents 0. Returns the full row. */
export const create = mutation({
  args: {
    swarmRunId: v.string(),
    name: v.string(),
    task: v.string(),
    customAgentId: v.optional(v.string()),
    role: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    status: v.optional(STATUS),
    wave: v.optional(v.number()),
    costCents: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await ctx.db.insert('SwarmMember', {
      id,
      swarmRunId: args.swarmRunId,
      name: args.name,
      task: args.task,
      customAgentId: args.customAgentId,
      role: args.role,
      systemPrompt: args.systemPrompt ?? '',
      status: args.status ?? 'queued',
      wave: args.wave ?? 1,
      costCents: args.costCents ?? 0,
      createdAt: now,
    });
    const stored = await ctx.db
      .query('SwarmMember')
      .withIndex('by_app_id', (q) => q.eq('id', id))
      .unique();
    return toRow(stored!);
  },
});

/** Transition a member (status/output/cost/timestamps). Only provided fields
 *  change. Returns the full row or null when the id is unknown. */
export const patch = mutation({
  args: {
    id: v.string(),
    status: v.optional(STATUS),
    output: v.optional(v.union(v.string(), v.null())),
    costCents: v.optional(v.number()),
    startedAt: v.optional(v.union(v.string(), v.null())),
    completedAt: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('SwarmMember')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d) return null;
    const patchObj: Record<string, unknown> = {};
    if (args.status !== undefined) patchObj.status = args.status;
    if (args.output !== undefined) patchObj.output = args.output === null ? undefined : args.output;
    if (args.costCents !== undefined) patchObj.costCents = args.costCents;
    if (args.startedAt !== undefined)
      patchObj.startedAt = args.startedAt === null ? undefined : args.startedAt;
    if (args.completedAt !== undefined)
      patchObj.completedAt = args.completedAt === null ? undefined : args.completedAt;
    await ctx.db.patch(d._id, patchObj);
    return toRow((await ctx.db.get(d._id))!);
  },
});
