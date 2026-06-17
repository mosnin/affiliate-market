import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * Pipeline data access — Convex replacement for `.from('Pipeline')` reads/writes
 * (pipelines GET/POST/PATCH/DELETE, deals-page bootstrap, onboarding).
 *
 * The pipeline DELETE flow re-homes or deletes the pipeline's DealStages first
 * (stages.reassignPipeline / stages.deleteByPipeline) — that orchestration stays
 * in the route; this module only swaps the Pipeline table hop.
 */

type PipelineFields = {
  id: string;
  spaceId: string;
  name: string;
  color: string;
  emoji?: string;
  position: number;
  createdAt: string;
};

function toRow(p: PipelineFields) {
  return {
    id: p.id,
    spaceId: p.spaceId,
    name: p.name,
    color: p.color,
    emoji: p.emoji ?? null,
    position: p.position,
    createdAt: p.createdAt,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** One pipeline by id scoped to a space, or null (pipelines PATCH/DELETE load).
 *  Mirrors `.eq('id').eq('spaceId')`. */
export const getByIdInSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('Pipeline')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p || p.spaceId !== args.spaceId) return null;
    return toRow(p);
  },
});

/** A space's pipelines ordered by position (pipelines GET, deals-page bootstrap,
 *  onboarding). Replaces `.eq('spaceId').order('position', asc)`. */
export const listBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Pipeline')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    rows.sort((a, b) => a.position - b.position);
    return rows.map(toRow);
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────

/** Next position at the end of a space's pipeline list (pipelines POST).
 *  Replaces `.eq('spaceId').order('position', desc).limit(1)`. */
export const nextPosition = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Pipeline')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const max = rows.reduce((m, p) => (p.position > m ? p.position : m), -1);
    return max + 1;
  },
});

/** Insert a pipeline. color defaults to PG '#6366f1'; emoji optional. The caller
 *  resolves position first (or passes 0 for the bootstrap default). */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    spaceId: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
    emoji: v.union(v.string(), v.null()),
    position: v.number(),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      spaceId: args.spaceId,
      name: args.name,
      color: args.color ?? '#6366f1',
      ...(args.emoji !== null ? { emoji: args.emoji } : {}),
      position: args.position,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('Pipeline', doc);
    return toRow(doc);
  },
});

/** Patch a pipeline (name/color/emoji), scoped to spaceId. Tri-state emoji: value
 *  to set, null to clear, omit to leave. Returns updated row or null on mismatch. */
export const updateById = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    emoji: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('Pipeline')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p || p.spaceId !== args.spaceId) return null;
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.color !== undefined) patch.color = args.color;
    if (args.emoji !== undefined) patch.emoji = args.emoji ?? undefined;
    if (Object.keys(patch).length > 0) await ctx.db.patch(p._id, patch);
    const updated = (await ctx.db.get(p._id))!;
    return toRow(updated);
  },
});

/** Delete a pipeline by id, scoped to spaceId (pipelines DELETE, AFTER the route
 *  re-homed/deleted its DealStages). Replaces `.delete().eq('id').eq('spaceId')`.
 *  Returns true iff deleted. */
export const deleteById = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const p = await ctx.db
      .query('Pipeline')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p || p.spaceId !== args.spaceId) return false;
    await ctx.db.delete(p._id);
    return true;
  },
});
