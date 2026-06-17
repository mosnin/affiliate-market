import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * AgentActivityLog data access — the Convex replacement for the `.from('AgentActivityLog')`
 * reads & writes: the activity feed, the deal/contact intelligence context reads,
 * recent-runs, the overnight brief, the manager rollup, the task-status audit
 * insert, and the reverse (undo) flow.
 *
 * The Contact:relatedContactId / Deal:relatedDealId joins in the activity feed
 * STAY IN LIB. These queries return only AgentActivityLog columns.
 *
 * NOTE on a pre-existing call-site bug (NOT fixed here — the call-site wave will
 * remap columns): app/api/agent/deal/[id] and contact/[id] select non-existent
 * columns `action` and `summary` (the table has `actionType` and `reasoning`, no
 * `summary`). `contextForDeal`/`contextForContact` below return the REAL columns
 * (actionType, reasoning) so the rewired lib can map them correctly; the bogus
 * names are dropped. Flagged in the report.
 */

const outcomeValidator = v.union(
  v.literal('completed'),
  v.literal('queued_for_approval'),
  v.literal('suggested'),
  v.literal('failed'),
);

function toActivityRow(a: Doc<'AgentActivityLog'>) {
  return {
    id: a.id,
    spaceId: a.spaceId,
    runId: a.runId,
    agentType: a.agentType,
    actionType: a.actionType,
    reasoning: a.reasoning ?? null,
    outcome: a.outcome,
    relatedContactId: a.relatedContactId ?? null,
    relatedDealId: a.relatedDealId ?? null,
    reversible: a.reversible,
    reversedAt: a.reversedAt ?? null,
    metadata: a.metadata ?? null,
    createdAt: a.createdAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The main activity feed: a space's entries newest-first (cap = limit, 50..200),
 *  optionally filtered by agentType and/or outcome (both applied in-handler after
 *  the spaceId range). Returns full rows; the lib joins Contact/Deal. */
export const feed = query({
  args: {
    spaceId: v.string(),
    limit: v.number(),
    agentType: v.optional(v.string()),
    outcome: v.optional(outcomeValidator),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentActivityLog')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .collect();
    const filtered = rows.filter(
      (a) =>
        (args.agentType === undefined || a.agentType === args.agentType) &&
        (args.outcome === undefined || a.outcome === args.outcome),
    );
    return filtered.slice(0, args.limit).map(toActivityRow);
  },
});

/** One entry by (id, spaceId), or null — the reverse-route verification read. */
export const getByIdForSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const a = await ctx.db
      .query('AgentActivityLog')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!a || a.spaceId !== args.spaceId) return null;
    return toActivityRow(a);
  },
});

/** A space's completed actions since `since` (overnight brief) — returns just
 *  actionType, the only column the brief groups. Mirrors `.eq('spaceId')
 *  .eq('outcome','completed').gte('createdAt', since)`. */
export const completedSince = query({
  args: { spaceId: v.string(), since: v.string() },
  handler: async (ctx, args): Promise<{ actionType: string }[]> => {
    const rows = await ctx.db
      .query('AgentActivityLog')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId).gte('createdAt', args.since))
      .collect();
    return rows.filter((a) => a.outcome === 'completed').map((a) => ({ actionType: a.actionType }));
  },
});

/** Recent distinct-run input for a space: the latest entries (cap 20) returning
 *  (runId, agentType, createdAt) newest-first. The lib dedupes to the 5 most
 *  recent runIds. Mirrors `.eq('spaceId').order('createdAt', desc).limit(20)`. */
export const recentRuns = query({
  args: { spaceId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentActivityLog')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .take(args.limit ?? 20);
    return rows.map((a) => ({ runId: a.runId, agentType: a.agentType, createdAt: a.createdAt }));
  },
});

/** Recent activity for a specific deal (deal intelligence), newest-first (cap 15).
 *  Mirrors `.eq('spaceId').eq('dealId'/'relatedDealId').order('createdAt', desc)
 *  .limit(15)`. Returns the real columns (actionType, reasoning) — see the bug
 *  note above; the buggy `action`/`summary` projection is intentionally dropped. */
export const contextForDeal = query({
  args: { spaceId: v.string(), dealId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentActivityLog')
      .withIndex('by_space_deal', (q) => q.eq('spaceId', args.spaceId).eq('relatedDealId', args.dealId))
      .order('desc')
      .take(args.limit ?? 15);
    return rows.map((a) => ({
      id: a.id,
      agentType: a.agentType,
      actionType: a.actionType,
      outcome: a.outcome,
      reasoning: a.reasoning ?? null,
      relatedDealId: a.relatedDealId ?? null,
      createdAt: a.createdAt,
    }));
  },
});

/** Recent activity for a specific contact (contact intelligence), newest-first
 *  (cap 15). Same shape/notes as contextForDeal. */
export const contextForContact = query({
  args: { spaceId: v.string(), contactId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentActivityLog')
      .withIndex('by_space_contact', (q) =>
        q.eq('spaceId', args.spaceId).eq('relatedContactId', args.contactId),
      )
      .order('desc')
      .take(args.limit ?? 15);
    return rows.map((a) => ({
      id: a.id,
      agentType: a.agentType,
      actionType: a.actionType,
      outcome: a.outcome,
      reasoning: a.reasoning ?? null,
      relatedContactId: a.relatedContactId ?? null,
      createdAt: a.createdAt,
    }));
  },
});

/** The manager rollup input: entries for a set of spaces since `since`, newest-
 *  first (cap 5000). Mirrors `.in('spaceId', spaceIds).gte('createdAt', since)
 *  .order('createdAt', desc).limit(5000)` selecting (spaceId, actionType, outcome,
 *  createdAt). The lib buckets per seller. */
export const rollupForSpaces = query({
  args: { spaceIds: v.array(v.string()), since: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cap = args.limit ?? 5000;
    const out: { spaceId: string; actionType: string; outcome: string; createdAt: string }[] = [];
    const seen = new Set<string>();
    for (const sid of args.spaceIds) {
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      const rows = await ctx.db
        .query('AgentActivityLog')
        .withIndex('by_space_created', (q) => q.eq('spaceId', sid).gte('createdAt', args.since))
        .collect();
      for (const a of rows) {
        out.push({
          spaceId: a.spaceId,
          actionType: a.actionType,
          outcome: a.outcome,
          createdAt: a.createdAt,
        });
      }
    }
    // newest-first, then cap (matches the order+limit the route applied globally).
    out.sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
    return out.slice(0, cap);
  },
});

// ── Writes ────────────────────────────────────────────────────────────────────

/** Append an activity log entry (the task-status audit insert; reversible/
 *  metadata default per the route). Best-effort at the call site (fire-and-
 *  forget) — the mutation just inserts. PG defaulted reversible=true. */
export const log = mutation({
  args: {
    spaceId: v.string(),
    runId: v.string(),
    agentType: v.string(),
    actionType: v.string(),
    outcome: outcomeValidator,
    reasoning: v.optional(v.union(v.string(), v.null())),
    relatedContactId: v.optional(v.union(v.string(), v.null())),
    relatedDealId: v.optional(v.union(v.string(), v.null())),
    reversible: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<{ id: string }> => {
    const id = crypto.randomUUID();
    await ctx.db.insert('AgentActivityLog', {
      id,
      spaceId: args.spaceId,
      runId: args.runId,
      agentType: args.agentType,
      actionType: args.actionType,
      outcome: args.outcome,
      ...(args.reasoning != null ? { reasoning: args.reasoning } : {}),
      ...(args.relatedContactId != null ? { relatedContactId: args.relatedContactId } : {}),
      ...(args.relatedDealId != null ? { relatedDealId: args.relatedDealId } : {}),
      reversible: args.reversible ?? true,
      metadata: args.metadata ?? {},
      createdAt: new Date().toISOString(),
    });
    return { id };
  },
});

/** Mark an entry reversed (reverse/undo route) — sets reversedAt. Scoped to
 *  (id, spaceId). Returns whether it existed. Mirrors `.update({ reversedAt })
 *  .eq('id').eq('spaceId')`. */
export const markReversed = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const a = await ctx.db
      .query('AgentActivityLog')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!a || a.spaceId !== args.spaceId) return { ok: false };
    await ctx.db.patch(a._id, { reversedAt: new Date().toISOString() });
    return { ok: true };
  },
});
