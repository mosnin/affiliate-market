import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * DealActivity data access — Convex replacement for `.from('DealActivity')`
 * reads/inserts. Append-only deal timeline: a "note on a deal", a logged call/
 * email/meeting, and the auto-logged stage_change / status_change rows the deal
 * update paths emit. (The free-form space Notes pad is a different table — see
 * deals/notes.ts.)
 *
 * Every write here is a plain insert; the deal-update orchestration (patch the
 * Deal, then log the activity) stays in the route/tool, which calls
 * deals.updateById + this insert. No DealActivity updates/deletes exist except
 * the Deal ON DELETE CASCADE (handled in deals.deleteById).
 */

const typeValidator = v.union(
  v.literal('note'),
  v.literal('call'),
  v.literal('email'),
  v.literal('meeting'),
  v.literal('follow_up'),
  v.literal('stage_change'),
  v.literal('status_change'),
);

type ActivityFields = {
  id: string;
  dealId: string;
  spaceId: string;
  type: 'note' | 'call' | 'email' | 'meeting' | 'follow_up' | 'stage_change' | 'status_change';
  content?: string;
  metadata?: unknown;
  createdAt: string;
};

function toRow(a: ActivityFields) {
  return {
    id: a.id,
    dealId: a.dealId,
    spaceId: a.spaceId,
    type: a.type,
    content: a.content ?? null,
    metadata: a.metadata ?? null,
    createdAt: a.createdAt,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────

/**
 * A deal's activity, newest-first, capped (deal detail GET limit 50, activity GET
 * full, card limit 3). Replaces `.eq('dealId', id)[.eq('spaceId')].order(
 * 'createdAt', desc)[.limit(n)]`. Rides by_deal; spaceId asserted in-handler
 * where the route scoped it.
 */
export const listByDeal = query({
  args: { dealId: v.string(), spaceId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DealActivity')
      .withIndex('by_deal', (q) => q.eq('dealId', args.dealId))
      .collect();
    const scoped =
      args.spaceId !== undefined ? rows.filter((a) => a.spaceId === args.spaceId) : rows;
    scoped.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const capped = args.limit !== undefined ? scoped.slice(0, args.limit) : scoped;
    return capped.map(toRow);
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Append a deal activity (activity POST, every note-on-deal / update-* / mark-* /
 * move-* / attach-product tool, deals PATCH auto-log). Replaces
 * `.insert({ id, dealId, spaceId, type, content, metadata })`. content/metadata
 * are optional (SQL NULL when omitted). Returns the inserted row.
 */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    dealId: v.string(),
    spaceId: v.string(),
    type: typeValidator,
    content: v.union(v.string(), v.null()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      dealId: args.dealId,
      spaceId: args.spaceId,
      type: args.type,
      ...(args.content !== null ? { content: args.content } : {}),
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('DealActivity', doc);
    return toRow(doc);
  },
});
