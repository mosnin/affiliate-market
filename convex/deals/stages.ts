import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * DealStage data access — Convex replacement for every `.from('DealStage')`
 * read/write across the stages routes, the kanban/board reads, the AI tools'
 * stage lookups, manager dashboards, and the cross-cutting routes.
 *
 * Cross-domain orchestration (re-homing deals on stage delete, deal-count
 * guards) stays in the route: the route calls deals.reassignStage /
 * deals.countByStage and these DealStage functions in sequence. This module
 * swaps only the DealStage table hop.
 */

const pipelineTypeValidator = v.union(
  v.literal('rental'),
  v.literal('buyer'),
  v.literal('seller'),
);
const kindValidator = v.union(
  v.literal('lead'),
  v.literal('qualified'),
  v.literal('active'),
  v.literal('under_contract'),
  v.literal('closing'),
  v.literal('closed'),
);

type StageFields = {
  id: string;
  spaceId: string;
  name: string;
  color: string;
  position: number;
  pipelineType?: 'rental' | 'buyer' | 'seller';
  pipelineId?: string;
  kind?: 'lead' | 'qualified' | 'active' | 'under_contract' | 'closing' | 'closed';
};

/** Full DealStage row in the legacy shape (`select('*')` callers): surface `id`,
 *  coerce absent optionals to the SQL NULLs callers expect. */
function toRow(s: StageFields) {
  return {
    id: s.id,
    spaceId: s.spaceId,
    name: s.name,
    color: s.color,
    position: s.position,
    pipelineType: s.pipelineType ?? null,
    pipelineId: s.pipelineId ?? null,
    kind: s.kind ?? null,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** One stage by id, or null. Mirrors `.eq('id').maybeSingle()` (card/notification
 *  stage-name lookup, move-deal-stage destination, deals PATCH name lookup). */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('DealStage')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return s ? toRow(s) : null;
  },
});

/** One stage by id scoped to a space, or null. Mirrors `.eq('id').eq('spaceId').
 *  maybeSingle()` (stages PATCH/DELETE load, deals POST/PATCH stage validation,
 *  create-deal stage check). */
export const getByIdInSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('DealStage')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!s || s.spaceId !== args.spaceId) return null;
    return toRow(s);
  },
});

/**
 * A space's stages ordered by position, optionally filtered by pipelineId OR
 * pipelineType. The workhorse replacing every `.from('DealStage').select('*').
 * eq('spaceId').order('position')` read (stages GET, kanban columns, deals page,
 * deal detail, analytics, find_deal/stuck/draft stage-name maps, sellers,
 * vectorize). Rides by_space; the optional pipeline filter + sort are applied
 * in-handler so one index serves every caller.
 */
export const listBySpace = query({
  args: {
    spaceId: v.string(),
    pipelineId: v.optional(v.string()),
    pipelineType: v.optional(pipelineTypeValidator),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DealStage')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const filtered = rows.filter((s) => {
      if (args.pipelineId !== undefined && s.pipelineId !== args.pipelineId) return false;
      if (args.pipelineType !== undefined && s.pipelineType !== args.pipelineType) return false;
      return true;
    });
    filtered.sort((a, b) => a.position - b.position);
    return filtered.map(toRow);
  },
});

/**
 * Stages for several spaces ordered by position (manager pipeline/deals/forecast/
 * sellers). Replaces `.from('DealStage').select(...).in('spaceId', spaceIds).
 * order('position')`. Fans out per space on by_space; sorts each space's set.
 */
export const listBySpaceIds = query({
  args: { spaceIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const all: StageFields[] = [];
    for (const spaceId of args.spaceIds) {
      const rows = await ctx.db
        .query('DealStage')
        .withIndex('by_space', (q) => q.eq('spaceId', spaceId))
        .collect();
      rows.sort((a, b) => a.position - b.position);
      all.push(...rows);
    }
    return all.map(toRow);
  },
});

/**
 * The first stage (lowest position) in a space, optionally constrained to a
 * pipelineType. Replaces the default-stage pickers `.eq('spaceId')[.eq(
 * 'pipelineType')].order('position', asc).limit(1)` (create-deal default/buyer/
 * seller routing, deals POST buyer/seller stage, demos convert first stage).
 */
export const firstStage = query({
  args: { spaceId: v.string(), pipelineType: v.optional(pipelineTypeValidator) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DealStage')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const pool =
      args.pipelineType !== undefined
        ? rows.filter((s) => s.pipelineType === args.pipelineType)
        : rows;
    pool.sort((a, b) => a.position - b.position);
    return pool[0] ? toRow(pool[0]) : null;
  },
});

/** Several stages by id (find_deal/stuck/analytics/draft/forecast/search
 *  stage-name maps). Replaces `.in('id', stageIds)` selecting id/name (+ color/
 *  position/kind). Returns full rows; callers pick the columns they used. */
export const listByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: StageFields[] = [];
    for (const id of args.ids) {
      const s = await ctx.db
        .query('DealStage')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (s) out.push(s);
    }
    return out.map(toRow);
  },
});

/** Stages in a space matching a pipelineType with a NULL pipelineId (pipelines
 *  GET bootstrap: adopt orphan stages into the new default pipeline). Replaces
 *  `.eq('spaceId').eq('pipelineType', t).is('pipelineId', null)`. */
export const listUnassignedByType = query({
  args: { spaceId: v.string(), pipelineType: pipelineTypeValidator },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DealStage')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows
      .filter((s) => s.pipelineType === args.pipelineType && s.pipelineId == null)
      .map(toRow);
  },
});

/** Stage ids belonging to a pipeline within a space (pipelines DELETE: gather
 *  the pipeline's stages to count deals / re-home / clear). Replaces
 *  `.eq('spaceId').eq('pipelineId', id).select('id')`. */
export const listByPipeline = query({
  args: { spaceId: v.string(), pipelineId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DealStage')
      .withIndex('by_pipeline', (q) => q.eq('pipelineId', args.pipelineId))
      .collect();
    return rows.filter((s) => s.spaceId === args.spaceId).map(toRow);
  },
});

/** Count of a space's stages (admin user/overview metrics). Replaces
 *  `.eq('spaceId').select('*', count exact, head true)`. */
export const countBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('DealStage')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.length;
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────

/** The next position at the end of a space's stage list, optionally constrained
 *  to a pipelineId or pipelineType (stages POST). Replaces `.eq('spaceId')
 *  [.eq('pipelineId'/'pipelineType')].order('position', desc).limit(1)`. */
export const nextPosition = query({
  args: {
    spaceId: v.string(),
    pipelineId: v.optional(v.string()),
    pipelineType: v.optional(pipelineTypeValidator),
  },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('DealStage')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const pool = rows.filter((s) => {
      if (args.pipelineId !== undefined && s.pipelineId !== args.pipelineId) return false;
      if (args.pipelineType !== undefined && s.pipelineType !== args.pipelineType) return false;
      return true;
    });
    const max = pool.reduce((m, s) => (s.position > m ? s.position : m), -1);
    return max + 1;
  },
});

/** Insert a stage. color defaults to PG '#6B7280'; pipelineType to 'rental' when
 *  omitted (mirrors the column default). Optional pipelineId/kind set when given.
 *  The caller (stages POST, pipelines bootstrap) resolves position first. */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    spaceId: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
    position: v.number(),
    pipelineType: v.optional(pipelineTypeValidator),
    pipelineId: v.optional(v.union(v.string(), v.null())),
    kind: v.optional(v.union(kindValidator, v.null())),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      spaceId: args.spaceId,
      name: args.name,
      color: args.color ?? '#6B7280',
      position: args.position,
      pipelineType: args.pipelineType ?? ('rental' as const),
      ...(args.pipelineId != null ? { pipelineId: args.pipelineId } : {}),
      ...(args.kind != null ? { kind: args.kind } : {}),
    };
    await ctx.db.insert('DealStage', doc);
    return toRow(doc);
  },
});

/** Bulk-insert several stages in one mutation (pipelines GET bootstrap default
 *  set). Returns the inserted rows. */
export const createMany = mutation({
  args: {
    stages: v.array(
      v.object({
        id: v.optional(v.string()),
        spaceId: v.string(),
        name: v.string(),
        color: v.optional(v.string()),
        position: v.number(),
        pipelineType: v.optional(pipelineTypeValidator),
        pipelineId: v.optional(v.union(v.string(), v.null())),
        kind: v.optional(v.union(kindValidator, v.null())),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const out: ReturnType<typeof toRow>[] = [];
    for (const s of args.stages) {
      const doc = {
        id: s.id ?? crypto.randomUUID(),
        spaceId: s.spaceId,
        name: s.name,
        color: s.color ?? '#6B7280',
        position: s.position,
        pipelineType: s.pipelineType ?? ('rental' as const),
        ...(s.pipelineId != null ? { pipelineId: s.pipelineId } : {}),
        ...(s.kind != null ? { kind: s.kind } : {}),
      };
      await ctx.db.insert('DealStage', doc);
      out.push(toRow(doc));
    }
    return out;
  },
});

/** Patch a stage (stages PATCH: name/color/kind), scoped to spaceId. Tri-state
 *  kind: value to set, null to clear, omit to leave. Returns updated row or null
 *  if id/space mismatch. */
export const updateById = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    kind: v.optional(v.union(kindValidator, v.null())),
  },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('DealStage')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!s || s.spaceId !== args.spaceId) return null;
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.color !== undefined) patch.color = args.color;
    if (args.kind !== undefined) patch.kind = args.kind ?? undefined;
    if (Object.keys(patch).length > 0) await ctx.db.patch(s._id, patch);
    const updated = (await ctx.db.get(s._id))!;
    return toRow(updated);
  },
});

/**
 * Reorder a space's stages: set each given stage's position by its index in the
 * provided ordered id list, scoped to spaceId. Replaces the stages/reorder route's
 * per-stage `.update({ position: index }).eq('id').eq('spaceId')` loop with one
 * serializable mutation. Ignores ids that don't belong to the space.
 */
export const reorder = mutation({
  args: { spaceId: v.string(), orderedIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    for (let i = 0; i < args.orderedIds.length; i++) {
      const s = await ctx.db
        .query('DealStage')
        .withIndex('by_app_id', (q) => q.eq('id', args.orderedIds[i]))
        .unique();
      if (!s || s.spaceId !== args.spaceId) continue;
      if (s.position !== i) await ctx.db.patch(s._id, { position: i });
    }
  },
});

/** Set pipelineId on several stages by id within a space (pipelines GET adopt
 *  orphans; POST create's stage-assign). Replaces `.update({ pipelineId }).in(
 *  'id', ids).eq('spaceId')`. */
export const setPipelineForStages = mutation({
  args: { ids: v.array(v.string()), spaceId: v.string(), pipelineId: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<number> => {
    let n = 0;
    for (const id of args.ids) {
      const s = await ctx.db
        .query('DealStage')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (!s || s.spaceId !== args.spaceId) continue;
      await ctx.db.patch(s._id, { pipelineId: args.pipelineId ?? undefined });
      n++;
    }
    return n;
  },
});

/** Set pipelineId on every stage currently in a pipeline (pipelines DELETE
 *  re-home to a target pipeline). Replaces `.update({ pipelineId: target }).
 *  eq('spaceId').eq('pipelineId', from)`. */
export const reassignPipeline = mutation({
  args: { spaceId: v.string(), fromPipelineId: v.string(), toPipelineId: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('DealStage')
      .withIndex('by_pipeline', (q) => q.eq('pipelineId', args.fromPipelineId))
      .collect();
    let n = 0;
    for (const s of rows) {
      if (s.spaceId !== args.spaceId) continue;
      await ctx.db.patch(s._id, { pipelineId: args.toPipelineId ?? undefined });
      n++;
    }
    return n;
  },
});

/**
 * Delete a single stage by id, scoped to spaceId (stages DELETE, AFTER the route
 * re-homed or confirmed no deals — Postgres would CASCADE deals, but the route
 * always re-stages first when deals exist). To honor the FK CASCADE for the
 * empty-stage path, any residual deals in the stage (and their children) are
 * cascaded here as a backstop. Returns true iff a stage was deleted.
 */
export const deleteById = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const s = await ctx.db
      .query('DealStage')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!s || s.spaceId !== args.spaceId) return false;

    // Backstop CASCADE: any deals still pointing at this stage (+ their children).
    const deals = await ctx.db
      .query('Deal')
      .withIndex('by_stage_position', (q) => q.eq('stageId', s.id))
      .collect();
    for (const deal of deals) {
      const activities = await ctx.db
        .query('DealActivity')
        .withIndex('by_deal', (q) => q.eq('dealId', deal.id))
        .collect();
      for (const a of activities) await ctx.db.delete(a._id);
      const checklist = await ctx.db
        .query('DealChecklistItem')
        .withIndex('by_deal_position', (q) => q.eq('dealId', deal.id))
        .collect();
      for (const c of checklist) await ctx.db.delete(c._id);
      const contacts = await ctx.db
        .query('DealContact')
        .withIndex('by_deal', (q) => q.eq('dealId', deal.id))
        .collect();
      for (const dc of contacts) await ctx.db.delete(dc._id);
      const documents = await ctx.db
        .query('DealDocument')
        .withIndex('by_deal_created', (q) => q.eq('dealId', deal.id))
        .collect();
      for (const doc of documents) await ctx.db.delete(doc._id);
      const reviews = await ctx.db
        .query('DealReviewRequest')
        .withIndex('by_deal_status', (q) => q.eq('dealId', deal.id))
        .collect();
      for (const r of reviews) {
        const comments = await ctx.db
          .query('DealReviewComment')
          .withIndex('by_request_created', (q) => q.eq('reviewRequestId', r.id))
          .collect();
        for (const cm of comments) await ctx.db.delete(cm._id);
        await ctx.db.delete(r._id);
      }
      await ctx.db.delete(deal._id);
    }

    await ctx.db.delete(s._id);
    return true;
  },
});

/** Delete every stage in a pipeline within a space (pipelines DELETE when the
 *  pipeline had no deals). Replaces `.delete().eq('spaceId').eq('pipelineId', id)`.
 *  Returns the count deleted. */
export const deleteByPipeline = mutation({
  args: { spaceId: v.string(), pipelineId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('DealStage')
      .withIndex('by_pipeline', (q) => q.eq('pipelineId', args.pipelineId))
      .collect();
    let n = 0;
    for (const s of rows) {
      if (s.spaceId !== args.spaceId) continue;
      await ctx.db.delete(s._id);
      n++;
    }
    return n;
  },
});
