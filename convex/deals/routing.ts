import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * DealRoutingRule data access — Convex replacement for `.from('DealRoutingRule')`
 * reads/writes (routing-rules GET/POST/PATCH/DELETE, the settings page, and the
 * company lead-routing engine in lib/company-routing.ts).
 *
 * A rule routes an inbound lead to either a specific agent (destinationUserId) OR
 * a pool method (destinationPoolMethod) — the destination XOR + budget-range
 * CHECKs and the cross-tenant destination-membership check are validated in the
 * route (zod + a CompanyMembership read), NOT here; this module just stores the
 * already-validated row. minBudget/maxBudget are numeric dollar amounts (NOT
 * cents). The old `42P01 -> []` migration-missing fallback is moot in Convex
 * (the table always exists).
 *
 * priority is the evaluation order (ASC); the engine also filters enabled=true.
 * One index (by_company_priority on companyId, priority, enabled) serves both the
 * full ordered list and the enabled subset (enabled folded in-handler).
 */

const poolMethodValidator = v.union(v.literal('round_robin'), v.literal('score_based'));

type RuleFields = {
  id: string;
  companyId: string;
  name: string;
  priority: number;
  enabled: boolean;
  leadType?: string;
  minBudget?: number;
  maxBudget?: number;
  matchTag?: string;
  destinationUserId?: string;
  destinationPoolMethod?: 'round_robin' | 'score_based';
  destinationPoolTag?: string;
  createdAt: string;
  updatedAt: string;
};

/** Full DealRoutingRule row (the RULE_COLUMNS shape both routes + the engine
 *  read): surface `id`, coerce absent optionals to the SQL NULLs callers expect. */
function toRow(r: RuleFields) {
  return {
    id: r.id,
    companyId: r.companyId,
    name: r.name,
    priority: r.priority,
    enabled: r.enabled,
    leadType: r.leadType ?? null,
    minBudget: r.minBudget ?? null,
    maxBudget: r.maxBudget ?? null,
    matchTag: r.matchTag ?? null,
    destinationUserId: r.destinationUserId ?? null,
    destinationPoolMethod: r.destinationPoolMethod ?? null,
    destinationPoolTag: r.destinationPoolTag ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Sort a company's rules by (priority ASC, createdAt ASC) — the engine's
 *  evaluation order, matching `.order('priority').order('createdAt')`. */
function byEvalOrder(a: RuleFields, b: RuleFields): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** One rule by id scoped to a company, or null (routing-rules PATCH/DELETE load).
 *  Mirrors `.eq('id').eq('companyId').maybeSingle()`. */
export const getByIdInCompany = query({
  args: { id: v.string(), companyId: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('DealRoutingRule')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.companyId !== args.companyId) return null;
    return toRow(r);
  },
});

/**
 * A company's rules in evaluation order (priority ASC, createdAt ASC), optionally
 * only the enabled ones. Replaces the routing-rules GET / settings page
 * `.eq('companyId').order('priority').order('createdAt')` AND the engine's
 * `.eq('companyId').eq('enabled', true).order('priority').order('createdAt')`.
 * Rides by_company_priority; enabled folded in-handler.
 */
export const listByCompany = query({
  args: { companyId: v.string(), enabledOnly: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DealRoutingRule')
      .withIndex('by_company_priority', (q) => q.eq('companyId', args.companyId))
      .collect();
    const filtered = args.enabledOnly ? rows.filter((r) => r.enabled) : rows;
    filtered.sort(byEvalOrder);
    return filtered.map(toRow);
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Create a routing rule (routing-rules POST, AFTER the route validated the XOR/
 * budget invariants + the destination-membership check). priority defaults to PG
 * 100, enabled to true. All the nullable fields pass through as given. Returns
 * the inserted row.
 */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    companyId: v.string(),
    name: v.string(),
    priority: v.optional(v.number()),
    enabled: v.optional(v.boolean()),
    leadType: v.union(v.string(), v.null()),
    minBudget: v.union(v.number(), v.null()),
    maxBudget: v.union(v.number(), v.null()),
    matchTag: v.union(v.string(), v.null()),
    destinationUserId: v.union(v.string(), v.null()),
    destinationPoolMethod: v.union(poolMethodValidator, v.null()),
    destinationPoolTag: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      companyId: args.companyId,
      name: args.name,
      priority: args.priority ?? 100,
      enabled: args.enabled ?? true,
      ...(args.leadType !== null ? { leadType: args.leadType } : {}),
      ...(args.minBudget !== null ? { minBudget: args.minBudget } : {}),
      ...(args.maxBudget !== null ? { maxBudget: args.maxBudget } : {}),
      ...(args.matchTag !== null ? { matchTag: args.matchTag } : {}),
      ...(args.destinationUserId !== null ? { destinationUserId: args.destinationUserId } : {}),
      ...(args.destinationPoolMethod !== null
        ? { destinationPoolMethod: args.destinationPoolMethod }
        : {}),
      ...(args.destinationPoolTag !== null ? { destinationPoolTag: args.destinationPoolTag } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('DealRoutingRule', doc);
    return toRow(doc);
  },
});

/**
 * Patch a routing rule (routing-rules PATCH), scoped to companyId, bumping
 * updatedAt. Each field is tri-state: a value to set, null to clear (for the
 * nullables), omit to leave unchanged. Returns the updated row, or null if the
 * id/company doesn't match. The route validates the resulting XOR/budget
 * invariants before calling.
 */
export const updateById = mutation({
  args: {
    id: v.string(),
    companyId: v.string(),
    name: v.optional(v.string()),
    priority: v.optional(v.number()),
    enabled: v.optional(v.boolean()),
    leadType: v.optional(v.union(v.string(), v.null())),
    minBudget: v.optional(v.union(v.number(), v.null())),
    maxBudget: v.optional(v.union(v.number(), v.null())),
    matchTag: v.optional(v.union(v.string(), v.null())),
    destinationUserId: v.optional(v.union(v.string(), v.null())),
    destinationPoolMethod: v.optional(v.union(poolMethodValidator, v.null())),
    destinationPoolTag: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('DealRoutingRule')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.companyId !== args.companyId) return null;
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    if (args.leadType !== undefined) patch.leadType = args.leadType ?? undefined;
    if (args.minBudget !== undefined) patch.minBudget = args.minBudget ?? undefined;
    if (args.maxBudget !== undefined) patch.maxBudget = args.maxBudget ?? undefined;
    if (args.matchTag !== undefined) patch.matchTag = args.matchTag ?? undefined;
    if (args.destinationUserId !== undefined)
      patch.destinationUserId = args.destinationUserId ?? undefined;
    if (args.destinationPoolMethod !== undefined)
      patch.destinationPoolMethod = args.destinationPoolMethod ?? undefined;
    if (args.destinationPoolTag !== undefined)
      patch.destinationPoolTag = args.destinationPoolTag ?? undefined;
    await ctx.db.patch(r._id, patch);
    const updated = (await ctx.db.get(r._id))!;
    return toRow(updated);
  },
});

/** Delete a rule by id, scoped to companyId (routing-rules DELETE). Replaces
 *  `.delete().eq('id').eq('companyId')`. Returns true iff deleted. */
export const deleteById = mutation({
  args: { id: v.string(), companyId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const r = await ctx.db
      .query('DealRoutingRule')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.companyId !== args.companyId) return false;
    await ctx.db.delete(r._id);
    return true;
  },
});
