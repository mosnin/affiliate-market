import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * Deal data access — the Convex replacement for every `.from('Deal')` read/write
 * across the pipeline routes, AI deal tools, manager dashboards, briefing/
 * analytics readers, and the cross-cutting routes (cards, mcp, search, agent,
 * admin, export).
 *
 * CROSS-DOMAIN STAYS IN LIB (CONVENTIONS): the deal routes/tools also touch
 * DealStage, DealContact, DealActivity (this domain — see those modules) and
 * Contact, Space, Demo, vectorize, etc. (other domains/SDKs). Each call site
 * swaps only ITS OWN table hop; the orchestration (e.g. "update deal + log a
 * stage_change activity + reindex") stays in the lib/route, calling these
 * functions plus the sibling-module functions. The one exception folded here is
 * `reorder` — a single-table multi-row shift that WAS a Postgres stored proc.
 *
 * The plpgsql `reorder_deal(p_deal_id, p_new_stage_id, p_new_position)` collapses
 * into the serializable `reorder` mutation below (see its doc).
 *
 * Deal.value is double precision and Deal.commissionRate is numeric(5,2) — these
 * are NOT money cents; they pass through as plain numbers (no recompute).
 */

const priorityValidator = v.union(v.literal('LOW'), v.literal('MEDIUM'), v.literal('HIGH'));
const statusValidator = v.union(
  v.literal('active'),
  v.literal('won'),
  v.literal('lost'),
  v.literal('on_hold'),
);

/** App columns of a Deal — the shape both a stored Doc and a fresh insert payload
 *  satisfy, so mappers need no _id stripping/casts. */
type DealFields = {
  id: string;
  spaceId: string;
  title: string;
  description?: string;
  value?: number;
  address?: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  closeDate?: string;
  stageId: string;
  position: number;
  status: 'active' | 'won' | 'lost' | 'on_hold';
  followUpAt?: string;
  sourceDemoId?: string;
  commissionRate?: number;
  probability?: number;
  milestones?: unknown;
  createdAt: string;
  updatedAt: string;
  stageChangedAt?: string;
  closedAt?: string;
  nextAction?: string;
  nextActionDueAt?: string;
  wonLostReason?: string;
  wonLostNote?: string;
  productId?: string;
};

/** Full Deal row in the legacy shape: drop _id/_creationTime, surface `id`,
 *  coerce absent optionals back to the SQL NULLs callers expect. `select('*')`
 *  call sites get this exact column set. The legacy Deal carried a denormalized
 *  `contactId` some SELECTs read; we surface it from the stored value (absent ->
 *  null) so those paths keep working. */
function toRow(d: DealFields & { contactId?: string }) {
  return {
    id: d.id,
    spaceId: d.spaceId,
    title: d.title,
    description: d.description ?? null,
    value: d.value ?? null,
    address: d.address ?? null,
    priority: d.priority,
    closeDate: d.closeDate ?? null,
    stageId: d.stageId,
    position: d.position,
    status: d.status,
    followUpAt: d.followUpAt ?? null,
    sourceDemoId: d.sourceDemoId ?? null,
    commissionRate: d.commissionRate ?? null,
    probability: d.probability ?? null,
    milestones: d.milestones ?? [],
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    stageChangedAt: d.stageChangedAt ?? null,
    closedAt: d.closedAt ?? null,
    nextAction: d.nextAction ?? null,
    nextActionDueAt: d.nextActionDueAt ?? null,
    wonLostReason: d.wonLostReason ?? null,
    wonLostNote: d.wonLostNote ?? null,
    productId: d.productId ?? null,
    contactId: d.contactId ?? null,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** One deal by id, or null. Mirrors `.eq('id').maybeSingle()`. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('Deal')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return d ? toRow(d) : null;
  },
});

/** One deal by id scoped to a space, or null. Mirrors `.eq('id').eq('spaceId').
 *  maybeSingle()` — the dominant per-deal read (deal CRUD, every ai-tool, agent
 *  routes, cards, commission-splits guard). */
export const getByIdInSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('Deal')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d || d.spaceId !== args.spaceId) return null;
    return toRow(d);
  },
});

/**
 * A space's deals with optional status / value-bearing / date-window filters,
 * ordered by `position` (default) or another column the caller sorts in-handler.
 * The workhorse replacing the many `.from('Deal').select(...).eq('spaceId')`
 * reads (deals GET kanban, find_deal, pipeline_summary, products commissions,
 * analytics, contacts performance, voice/realtime context, vectorize sync).
 *
 * Rides by_space_position (equality on spaceId). status, when given, is filtered
 * in-handler; the caller does any value/date sort it needs on the returned rows
 * (space-scoped sets are small). `limit` caps after filtering.
 */
export const listBySpace = query({
  args: {
    spaceId: v.string(),
    statuses: v.optional(v.array(statusValidator)),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Deal')
      .withIndex('by_space_position', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const statusSet = args.statuses ? new Set(args.statuses) : null;
    const filtered = statusSet ? rows.filter((d) => statusSet.has(d.status)) : rows;
    const capped = args.limit !== undefined ? filtered.slice(0, args.limit) : filtered;
    return capped.map(toRow);
  },
});

/**
 * Deals for a set of stages within a space, ordered by position. Replaces the
 * stages GET / seller deals-page `.eq('spaceId').in('stageId', stageIds).order(
 * 'position')` read. Fans out over by_stage_position per stage, then asserts the
 * space; merges preserving (stageId, position) order the board expects.
 */
export const listBySpaceStages = query({
  args: { spaceId: v.string(), stageIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const all: (DealFields & { contactId?: string })[] = [];
    for (const stageId of args.stageIds) {
      const rows = await ctx.db
        .query('Deal')
        .withIndex('by_stage_position', (q) => q.eq('stageId', stageId))
        .collect();
      for (const d of rows) if (d.spaceId === args.spaceId) all.push(d);
    }
    return all.map(toRow);
  },
});

/**
 * Deals across several spaces (manager dashboards: pipeline, deals, forecast,
 * analytics, brief, sellers, morning, weekly-report, export, company snapshot).
 * Replaces `.from('Deal').select(...).in('spaceId', spaceIds)[.eq('status')]
 * [.in('status')][.gte/.lte('updatedAt'/'createdAt')]`. Fans out per space on
 * by_space_position; status / date windows are filtered in-handler (team sizes
 * are small so the fan-out is cheap). `limit` caps the merged set. The caller
 * does its own sort (value desc, createdAt desc, etc.) on the returned rows.
 */
export const listBySpaceIds = query({
  args: {
    spaceIds: v.array(v.string()),
    statuses: v.optional(v.array(statusValidator)),
    createdAtGte: v.optional(v.string()),
    createdAtLte: v.optional(v.string()),
    updatedAtGte: v.optional(v.string()),
    updatedAtLte: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const statusSet = args.statuses ? new Set(args.statuses) : null;
    const all: (DealFields & { contactId?: string })[] = [];
    for (const spaceId of args.spaceIds) {
      const rows = await ctx.db
        .query('Deal')
        .withIndex('by_space_position', (q) => q.eq('spaceId', spaceId))
        .collect();
      for (const d of rows) {
        if (statusSet && !statusSet.has(d.status)) continue;
        if (args.createdAtGte !== undefined && d.createdAt < args.createdAtGte) continue;
        if (args.createdAtLte !== undefined && d.createdAt > args.createdAtLte) continue;
        if (args.updatedAtGte !== undefined && d.updatedAt < args.updatedAtGte) continue;
        if (args.updatedAtLte !== undefined && d.updatedAt > args.updatedAtLte) continue;
        all.push(d);
      }
    }
    const capped = args.limit !== undefined ? all.slice(0, args.limit) : all;
    return capped.map(toRow);
  },
});

/**
 * Active deals in a space older than a cutoff (find_stuck_deals / manager
 * morning stuck candidates). Replaces `.eq('spaceId').eq('status','active').
 * lt('updatedAt', cutoff).order('updatedAt', asc).limit(n)`. Filtered in-handler
 * on by_space_position, sorted oldest-first, capped.
 */
export const listStuckBySpace = query({
  args: { spaceId: v.string(), updatedBefore: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Deal')
      .withIndex('by_space_position', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const stuck = rows.filter((d) => d.status === 'active' && d.updatedAt < args.updatedBefore);
    stuck.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
    const capped = args.limit !== undefined ? stuck.slice(0, args.limit) : stuck;
    return capped.map(toRow);
  },
});

/**
 * A space's deals with a non-null followUpAt, ordered by followUpAt asc.
 * Replaces the follow-ups page `.eq('spaceId').not('followUpAt', is, null).
 * order('followUpAt', asc)`. Rides by_space_follow_up.
 */
export const listFollowUpsBySpace = query({
  args: { spaceId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Deal')
      .withIndex('by_space_follow_up', (q) => q.eq('spaceId', args.spaceId))
      .order('asc')
      .collect();
    const withFollowUp = rows.filter((d) => d.followUpAt != null);
    const capped = args.limit !== undefined ? withFollowUp.slice(0, args.limit) : withFollowUp;
    return capped.map(toRow);
  },
});

/**
 * Count of a space's deals with an overdue follow-up (manager layout badge).
 * Replaces `.in('spaceId', ids).not('followUpAt', is, null).lte('followUpAt',
 * now).select('id', count exact)`. Fans out per space; counts in-handler.
 */
export const countOverdueFollowUps = query({
  args: { spaceIds: v.array(v.string()), now: v.string() },
  handler: async (ctx, args): Promise<number> => {
    let n = 0;
    for (const spaceId of args.spaceIds) {
      const rows = await ctx.db
        .query('Deal')
        .withIndex('by_space_follow_up', (q) => q.eq('spaceId', spaceId))
        .collect();
      for (const d of rows) if (d.followUpAt != null && d.followUpAt <= args.now) n++;
    }
    return n;
  },
});

/**
 * Deals due to close on a given date (briefing tomorrow) or within a closeDate
 * window (find_deal closing-before, tip categories). Replaces
 * `.eq('spaceId')[.eq('status')].eq('closeDate', day)` and the
 * `.not('closeDate', is, null).lte('closeDate', cutoff)` / `.gte().lte()` reads.
 * Filtered in-handler on by_space_status (status equality when given) or
 * by_space_position (no status). `closeDateEq` matches a date-only prefix.
 */
export const listByCloseDate = query({
  args: {
    spaceId: v.string(),
    status: v.optional(statusValidator),
    closeDateEq: v.optional(v.string()),
    closeDateGte: v.optional(v.string()),
    closeDateLte: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows =
      args.status !== undefined
        ? await ctx.db
            .query('Deal')
            .withIndex('by_space_status', (q) =>
              q.eq('spaceId', args.spaceId).eq('status', args.status!),
            )
            .collect()
        : await ctx.db
            .query('Deal')
            .withIndex('by_space_position', (q) => q.eq('spaceId', args.spaceId))
            .collect();
    const filtered = rows.filter((d) => {
      if (d.closeDate == null) return false;
      if (args.closeDateEq !== undefined && !d.closeDate.startsWith(args.closeDateEq)) return false;
      if (args.closeDateGte !== undefined && d.closeDate < args.closeDateGte) return false;
      if (args.closeDateLte !== undefined && d.closeDate > args.closeDateLte) return false;
      return true;
    });
    const capped = args.limit !== undefined ? filtered.slice(0, args.limit) : filtered;
    return capped.map(toRow);
  },
});

/** A product's deals in a space, newest-updated first (products/[id] API +
 *  seller product page). Replaces `.eq('productId').eq('spaceId').order(
 *  'updatedAt', desc).limit(n)`. Rides by_product, asserts space. */
export const listByProduct = query({
  args: { productId: v.string(), spaceId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Deal')
      .withIndex('by_product', (q) => q.eq('productId', args.productId))
      .collect();
    const scoped = rows.filter((d) => d.spaceId === args.spaceId);
    scoped.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    const capped = args.limit !== undefined ? scoped.slice(0, args.limit) : scoped;
    return capped.map(toRow);
  },
});

/** sourceDemoIds among a space's deals that are already converted (notifications
 *  "demo converted?" + demos/convert "already converted?" check). Replaces
 *  `.eq('spaceId').in('sourceDemoId', demoIds).select('sourceDemoId')` and the
 *  `.eq('sourceDemoId', demoId).select('id')` existence check. */
export const findBySourceDemo = query({
  args: { demoIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: { id: string; spaceId: string; sourceDemoId: string }[] = [];
    for (const demoId of args.demoIds) {
      const rows = await ctx.db
        .query('Deal')
        .withIndex('by_source_demo', (q) => q.eq('sourceDemoId', demoId))
        .collect();
      for (const d of rows)
        out.push({ id: d.id, spaceId: d.spaceId, sourceDemoId: d.sourceDemoId! });
    }
    return out;
  },
});

/** Several deals by id within a space (agent memory/insights/reviews enrich).
 *  Replaces `.in('id', dealIds).eq('spaceId', space.id)`. */
export const listByIds = query({
  args: { ids: v.array(v.string()), spaceId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const out: (DealFields & { contactId?: string })[] = [];
    for (const id of args.ids) {
      const d = await ctx.db
        .query('Deal')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (!d) continue;
      if (args.spaceId !== undefined && d.spaceId !== args.spaceId) continue;
      out.push(d);
    }
    return out.map(toRow);
  },
});

/** Substring search over a space's deals (title / address), case-insensitive,
 *  capped. Replaces the chat/search `.eq('spaceId').or('title.ilike.%t%,
 *  address.ilike.%t%').limit(n)`. `term` is the raw needle. */
export const searchBySpace = query({
  args: { spaceId: v.string(), term: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const needle = args.term.trim().toLowerCase();
    const rows = await ctx.db
      .query('Deal')
      .withIndex('by_space_position', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const matched = needle
      ? rows.filter(
          (d) =>
            d.title.toLowerCase().includes(needle) ||
            (d.address ?? '').toLowerCase().includes(needle),
        )
      : rows;
    return matched.slice(0, args.limit ?? 8).map(toRow);
  },
});

/** Total deal count for a space, optionally status-scoped (admin pages,
 *  leaderboard, personalized-prompt). Replaces `.eq('spaceId')[.eq('status')]
 *  .select('*', count exact, head true)`. */
export const countBySpace = query({
  args: { spaceId: v.string(), status: v.optional(statusValidator) },
  handler: async (ctx, args): Promise<number> => {
    const rows =
      args.status !== undefined
        ? await ctx.db
            .query('Deal')
            .withIndex('by_space_status', (q) =>
              q.eq('spaceId', args.spaceId).eq('status', args.status!),
            )
            .collect()
        : await ctx.db
            .query('Deal')
            .withIndex('by_space_position', (q) => q.eq('spaceId', args.spaceId))
            .collect();
    return rows.length;
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Insert a deal. The caller (deals POST / create-deal tool / demos convert)
 * resolves the final stageId + next position first (via DealStage reads +
 * `nextPositionInStage` below), then calls this. Tri-state nullable fields: pass
 * a value to set, null to leave as SQL NULL. position/priority/status/milestones
 * default to the PG defaults when omitted. Returns the inserted row.
 */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    spaceId: v.string(),
    title: v.string(),
    description: v.union(v.string(), v.null()),
    value: v.union(v.number(), v.null()),
    address: v.union(v.string(), v.null()),
    priority: v.optional(priorityValidator),
    closeDate: v.union(v.string(), v.null()),
    stageId: v.string(),
    position: v.optional(v.number()),
    status: v.optional(statusValidator),
    stageChangedAt: v.union(v.string(), v.null()),
    followUpAt: v.union(v.string(), v.null()),
    commissionRate: v.union(v.number(), v.null()),
    probability: v.union(v.number(), v.null()),
    milestones: v.optional(v.any()),
    sourceDemoId: v.union(v.string(), v.null()),
    productId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      spaceId: args.spaceId,
      title: args.title,
      ...(args.description !== null ? { description: args.description } : {}),
      ...(args.value !== null ? { value: args.value } : {}),
      ...(args.address !== null ? { address: args.address } : {}),
      priority: args.priority ?? ('MEDIUM' as const),
      ...(args.closeDate !== null ? { closeDate: args.closeDate } : {}),
      stageId: args.stageId,
      position: args.position ?? 0,
      status: args.status ?? ('active' as const),
      ...(args.stageChangedAt !== null ? { stageChangedAt: args.stageChangedAt } : {}),
      ...(args.followUpAt !== null ? { followUpAt: args.followUpAt } : {}),
      ...(args.commissionRate !== null ? { commissionRate: args.commissionRate } : {}),
      ...(args.probability !== null ? { probability: args.probability } : {}),
      milestones: args.milestones ?? [],
      ...(args.sourceDemoId !== null ? { sourceDemoId: args.sourceDemoId } : {}),
      ...(args.productId !== null ? { productId: args.productId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('Deal', doc);
    return toRow(doc);
  },
});

/**
 * The next position at the end of a stage (max(position)+1), scoped to spaceId
 * where the caller scoped it. Replaces the `.eq('stageId')[.eq('spaceId')].order(
 * 'position', desc).limit(1)` pre-insert read every create path runs.
 */
export const nextPositionInStage = query({
  args: { stageId: v.string(), spaceId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Deal')
      .withIndex('by_stage_position', (q) => q.eq('stageId', args.stageId))
      .order('desc')
      .collect();
    for (const d of rows) {
      if (args.spaceId !== undefined && d.spaceId !== args.spaceId) continue;
      return d.position + 1;
    }
    return 0;
  },
});

/**
 * Generic owner PATCH of a deal (deals PATCH, every update-* / mark-* / move-*
 * / attach-product ai-tool, agent follow-up reverse). Applies any provided
 * field, scoped to spaceId so a between-check-and-write reassignment can't
 * cross-tenant the row, always bumping updatedAt. Returns the updated row, or
 * null if the id/space doesn't match. The caller logs any DealActivity (sibling
 * module) and computes stageChangedAt/closedAt itself, passing them in.
 *
 * Tri-state nullable fields: pass a value to set, null to clear, omit to leave.
 */
export const updateById = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    value: v.optional(v.union(v.number(), v.null())),
    address: v.optional(v.union(v.string(), v.null())),
    priority: v.optional(priorityValidator),
    closeDate: v.optional(v.union(v.string(), v.null())),
    stageId: v.optional(v.string()),
    position: v.optional(v.number()),
    status: v.optional(statusValidator),
    stageChangedAt: v.optional(v.union(v.string(), v.null())),
    closedAt: v.optional(v.union(v.string(), v.null())),
    followUpAt: v.optional(v.union(v.string(), v.null())),
    milestones: v.optional(v.any()),
    nextAction: v.optional(v.union(v.string(), v.null())),
    nextActionDueAt: v.optional(v.union(v.string(), v.null())),
    commissionRate: v.optional(v.union(v.number(), v.null())),
    probability: v.optional(v.union(v.number(), v.null())),
    productId: v.optional(v.union(v.string(), v.null())),
    wonLostReason: v.optional(v.union(v.string(), v.null())),
    wonLostNote: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('Deal')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d || d.spaceId !== args.spaceId) return null;

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.title !== undefined) patch.title = args.title;
    if (args.description !== undefined) patch.description = args.description ?? undefined;
    if (args.value !== undefined) patch.value = args.value ?? undefined;
    if (args.address !== undefined) patch.address = args.address ?? undefined;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.closeDate !== undefined) patch.closeDate = args.closeDate ?? undefined;
    if (args.stageId !== undefined) patch.stageId = args.stageId;
    if (args.position !== undefined) patch.position = args.position;
    if (args.status !== undefined) patch.status = args.status;
    if (args.stageChangedAt !== undefined) patch.stageChangedAt = args.stageChangedAt ?? undefined;
    if (args.closedAt !== undefined) patch.closedAt = args.closedAt ?? undefined;
    if (args.followUpAt !== undefined) patch.followUpAt = args.followUpAt ?? undefined;
    if (args.milestones !== undefined) patch.milestones = args.milestones;
    if (args.nextAction !== undefined) patch.nextAction = args.nextAction ?? undefined;
    if (args.nextActionDueAt !== undefined)
      patch.nextActionDueAt = args.nextActionDueAt ?? undefined;
    if (args.commissionRate !== undefined) patch.commissionRate = args.commissionRate ?? undefined;
    if (args.probability !== undefined) patch.probability = args.probability ?? undefined;
    if (args.productId !== undefined) patch.productId = args.productId ?? undefined;
    if (args.wonLostReason !== undefined) patch.wonLostReason = args.wonLostReason ?? undefined;
    if (args.wonLostNote !== undefined) patch.wonLostNote = args.wonLostNote ?? undefined;

    await ctx.db.patch(d._id, patch);
    const updated = (await ctx.db.get(d._id))!;
    return toRow(updated);
  },
});

/**
 * Re-home every deal in a stage to a target stage (stages DELETE when the stage
 * still has deals; pipelines DELETE re-stages too). Replaces
 * `.update({ stageId: target }).eq('spaceId').eq('stageId', from)`. Returns the
 * count moved. (No position rebalance — matches the old route, which only
 * reassigned stageId.)
 */
export const reassignStage = mutation({
  args: { fromStageId: v.string(), toStageId: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Deal')
      .withIndex('by_stage_position', (q) => q.eq('stageId', args.fromStageId))
      .collect();
    let moved = 0;
    const now = new Date().toISOString();
    for (const d of rows) {
      if (d.spaceId !== args.spaceId) continue;
      await ctx.db.patch(d._id, { stageId: args.toStageId, updatedAt: now });
      moved++;
    }
    return moved;
  },
});

/**
 * Null the productId link on every deal pointing at a product (the cross-backend
 * ON DELETE SET NULL the Product DELETE route relies on, now that Product lives
 * in Convex/marketplace and Deal lives here). Replaces
 * `.from('Deal').update({ productId: null }).eq('productId', id)`. Returns the
 * number of deals unlinked.
 */
export const clearProductId = mutation({
  args: { productId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Deal')
      .withIndex('by_product', (q) => q.eq('productId', args.productId))
      .collect();
    const now = new Date().toISOString();
    for (const d of rows) {
      await ctx.db.patch(d._id, { productId: undefined, updatedAt: now });
    }
    return rows.length;
  },
});

/**
 * REIMPLEMENTS the Postgres stored proc `reorder_deal(p_deal_id, p_new_stage_id,
 * p_new_position)` (supabase/schema.current.sql) — the drag-and-drop kanban move,
 * race-safe. The proc did two UPDATEs in one transaction:
 *   1. Shift every OTHER deal in the target stage whose position >= newPosition
 *      up by one (make room): `UPDATE Deal SET position = position + 1 WHERE
 *      stageId = p_new_stage_id AND position >= p_new_position AND id != p_deal_id`.
 *   2. Place the moved deal: `SET stageId = p_new_stage_id, position =
 *      p_new_position, stageChangedAt = (now() if stage actually changed else
 *      unchanged), updatedAt = now() WHERE id = p_deal_id`.
 * Convex mutations are serializable, so this single mutation IS the transaction —
 * no two concurrent drags can both read the same positions and double-increment
 * (the race the proc was introduced to kill). The route's ownership checks
 * (deal+stage belong to the space) stay in the route; this mirrors the proc,
 * which moved by id alone. Returns the moved deal row (the route then re-fetched
 * it via `.select('*')` — callers can use this directly instead).
 */
export const reorder = mutation({
  args: { dealId: v.string(), newStageId: v.string(), newPosition: v.number() },
  handler: async (ctx, args) => {
    const deal = await ctx.db
      .query('Deal')
      .withIndex('by_app_id', (q) => q.eq('id', args.dealId))
      .unique();
    if (!deal) return null;

    const now = new Date().toISOString();

    // Step 1: shift the other deals in the target stage at/after newPosition up.
    const inTarget = await ctx.db
      .query('Deal')
      .withIndex('by_stage_position', (q) =>
        q.eq('stageId', args.newStageId).gte('position', args.newPosition),
      )
      .collect();
    for (const other of inTarget) {
      if (other.id === args.dealId) continue;
      await ctx.db.patch(other._id, { position: other.position + 1 });
    }

    // Step 2: place the moved deal; bump stageChangedAt only if the stage changed.
    const stageChanged = deal.stageId !== args.newStageId;
    await ctx.db.patch(deal._id, {
      stageId: args.newStageId,
      position: args.newPosition,
      ...(stageChanged ? { stageChangedAt: now } : {}),
      updatedAt: now,
    });

    const updated = (await ctx.db.get(deal._id))!;
    return toRow(updated);
  },
});

/**
 * Cascade-delete a deal (deals DELETE, manager lead delete/unassign-orphan
 * sweep). Replaces the Postgres ON DELETE CASCADE from Deal: removes the deal's
 * DealActivity, DealChecklistItem, DealContact, DealDocument, and
 * DealReviewRequest (-> DealReviewComment), then the Deal. Scoped to spaceId so
 * a stale id can't cross-tenant. The route captured DealDocument storagePaths
 * for blob cleanup BEFORE calling this (documents.listByDeal), since the rows
 * are gone after. Returns true iff a deal was deleted.
 */
export const deleteById = mutation({
  args: { id: v.string(), spaceId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<boolean> => {
    const deal = await ctx.db
      .query('Deal')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!deal) return false;
    if (args.spaceId !== undefined && deal.spaceId !== args.spaceId) return false;

    // CASCADE children (FK ON DELETE CASCADE in Postgres).
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

    // Review requests cascade to their comments (FK ON DELETE CASCADE).
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
    return true;
  },
});

// ── Aggregate helpers (typed projections the dashboards fold) ────────────────

/** Minimal columns for the manager/analytics aggregations that only need a few
 *  fields across many spaces — avoids shipping full rows. Mirrors the narrow
 *  `.select('spaceId, value, status, ...')` projections. status/date filters as
 *  in listBySpaceIds. The caller sums/buckets the result. */
export const projectBySpaceIds = query({
  args: {
    spaceIds: v.array(v.string()),
    statuses: v.optional(v.array(statusValidator)),
    createdAtGte: v.optional(v.string()),
    updatedAtGte: v.optional(v.string()),
    updatedAtLte: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const statusSet = args.statuses ? new Set(args.statuses) : null;
    const out: Array<{
      id: string;
      spaceId: string;
      value: number | null;
      commissionRate: number | null;
      status: string;
      stageId: string;
      createdAt: string;
      updatedAt: string;
      closedAt: string | null;
      stageChangedAt: string | null;
    }> = [];
    for (const spaceId of args.spaceIds) {
      const rows: Doc<'Deal'>[] = await ctx.db
        .query('Deal')
        .withIndex('by_space_position', (q) => q.eq('spaceId', spaceId))
        .collect();
      for (const d of rows) {
        if (statusSet && !statusSet.has(d.status)) continue;
        if (args.createdAtGte !== undefined && d.createdAt < args.createdAtGte) continue;
        if (args.updatedAtGte !== undefined && d.updatedAt < args.updatedAtGte) continue;
        if (args.updatedAtLte !== undefined && d.updatedAt > args.updatedAtLte) continue;
        out.push({
          id: d.id,
          spaceId: d.spaceId,
          value: d.value ?? null,
          commissionRate: d.commissionRate ?? null,
          status: d.status,
          stageId: d.stageId,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          closedAt: d.closedAt ?? null,
          stageChangedAt: d.stageChangedAt ?? null,
        });
      }
    }
    return out;
  },
});
