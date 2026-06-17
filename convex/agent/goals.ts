import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * AgentGoal data access — the Convex replacement for the `.from('AgentGoal')`
 * reads & writes in the goals API and the contact-context route.
 *
 * The Contact:contactId(id,name) join in the list read STAYS IN LIB (Contact is
 * another domain); these queries return only AgentGoal columns. The status guards
 * (PATCH/DELETE pre-read by id, idempotent already-cancelled) are preserved as
 * read-then-patch inside one mutation.
 */

const goalStatusValidator = v.union(
  v.literal('active'),
  v.literal('completed'),
  v.literal('cancelled'),
  v.literal('paused'),
);
const goalTypeValidator = v.union(
  v.literal('follow_up_sequence'),
  v.literal('demo_booking'),
  v.literal('offer_progress'),
  v.literal('deal_close'),
  v.literal('reengagement'),
  v.literal('custom'),
);

function toGoalRow(g: Doc<'AgentGoal'>) {
  return {
    id: g.id,
    spaceId: g.spaceId,
    contactId: g.contactId ?? null,
    dealId: g.dealId ?? null,
    goalType: g.goalType,
    description: g.description,
    instructions: g.instructions ?? null,
    status: g.status,
    priority: g.priority,
    metadata: g.metadata ?? {},
    completedAt: g.completedAt ?? null,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A space's goals in a status (optionally filtered to a contact), ordered
 *  (priority desc, createdAt desc), capped. Mirrors the goals list query. */
export const listBySpace = query({
  args: {
    spaceId: v.string(),
    status: goalStatusValidator,
    contactId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentGoal')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', args.status))
      .collect();
    const filtered =
      args.contactId !== undefined ? rows.filter((g) => g.contactId === args.contactId) : rows;
    filtered.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    });
    return filtered.slice(0, args.limit ?? 20).map(toGoalRow);
  },
});

/** One goal by (id, spaceId), or null — the PATCH/DELETE ownership pre-read. */
export const getByIdForSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const g = await ctx.db
      .query('AgentGoal')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!g || g.spaceId !== args.spaceId) return null;
    return toGoalRow(g);
  },
});

/** The highest-priority ACTIVE goal's goalType for a contact (contact-context).
 *  Mirrors `.eq('spaceId').eq('contactId').eq('status','active').order('priority',
 *  desc).limit(1)` selecting only goalType. */
export const activeGoalTypeForContact = query({
  args: { spaceId: v.string(), contactId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const rows = await ctx.db
      .query('AgentGoal')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', 'active'))
      .collect();
    const forContact = rows.filter((g) => g.contactId === args.contactId);
    forContact.sort((a, b) => b.priority - a.priority);
    return forContact[0]?.goalType ?? null;
  },
});

// ── Writes ────────────────────────────────────────────────────────────────────

/** Create a goal (status hardcoded 'active' by the route). Mirrors the goals
 *  POST insert; returns the new row. */
export const create = mutation({
  args: {
    spaceId: v.string(),
    goalType: goalTypeValidator,
    description: v.string(),
    instructions: v.union(v.string(), v.null()),
    contactId: v.union(v.string(), v.null()),
    dealId: v.union(v.string(), v.null()),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      goalType: args.goalType,
      description: args.description,
      ...(args.instructions !== null ? { instructions: args.instructions } : {}),
      ...(args.contactId !== null ? { contactId: args.contactId } : {}),
      ...(args.dealId !== null ? { dealId: args.dealId } : {}),
      status: 'active' as const,
      priority: args.priority ?? 0,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('AgentGoal', doc);
    return toGoalRow(doc as Doc<'AgentGoal'>);
  },
});

export interface UpdateStatusResult {
  ok: boolean;
  /** 'not_found' when the goal isn't in the space. */
  error?: 'not_found';
  goal: ReturnType<typeof toGoalRow> | null;
}

/**
 * Update a goal's status (PATCH): always sets updatedAt; sets completedAt when
 * status becomes 'completed'; merges metadata when completionNotes provided.
 * Scoped to (id, spaceId) — read-then-patch. Mirrors the PATCH route.
 */
export const updateStatus = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    status: goalStatusValidator,
    completionNotes: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<UpdateStatusResult> => {
    const g = await ctx.db
      .query('AgentGoal')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!g || g.spaceId !== args.spaceId) return { ok: false, error: 'not_found', goal: null };

    const patch: Record<string, unknown> = {
      status: args.status,
      updatedAt: new Date().toISOString(),
    };
    if (args.status === 'completed') patch.completedAt = new Date().toISOString();
    if (args.completionNotes !== undefined) {
      const md = (g.metadata as Record<string, unknown> | null | undefined) ?? {};
      patch.metadata = { ...md, completionNotes: args.completionNotes };
    }
    await ctx.db.patch(g._id, patch);
    const updated = (await ctx.db.get(g._id))!;
    return { ok: true, goal: toGoalRow(updated) };
  },
});

export interface CancelResult {
  /** 'cancelled' = just cancelled; 'already' = was already cancelled (idempotent);
   *  'not_found' = not in space. */
  outcome: 'cancelled' | 'already' | 'not_found';
}

/**
 * Soft-delete a goal by flipping status -> 'cancelled' (DELETE route). Idempotent:
 * if already cancelled, reports 'already' without re-writing (the route returned
 * 200 OK in that case). Scoped to (id, spaceId).
 */
export const cancel = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<CancelResult> => {
    const g = await ctx.db
      .query('AgentGoal')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!g || g.spaceId !== args.spaceId) return { outcome: 'not_found' };
    if (g.status === 'cancelled') return { outcome: 'already' };
    await ctx.db.patch(g._id, { status: 'cancelled', updatedAt: new Date().toISOString() });
    return { outcome: 'cancelled' };
  },
});
