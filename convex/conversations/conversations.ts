import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * Conversation data access (SELLER surface) — the Convex replacement for the
 * `.from('Conversation')` reads & writes in app/api/ai/conversations/**,
 * app/api/ai/task/route.ts, and app/s/[slug]/cola/page.tsx.
 *
 * The seller surface must never serve a manager/team conversation. Today those
 * live in the SAME table keyed by spaceId and are distinguished only by a
 * reserved title prefix (lib/chat/conversation-access). Convex has no `NOT LIKE`,
 * so list reads return the space's rows and the caller (lib) applies the
 * reserved-title exclusion — exactly as the old `.not('title','like', …)` did,
 * just moved one hop out. The per-conversation guards (resolve / rename / delete)
 * already re-check the title in the route, so nothing is exposed.
 *
 * Cross-surface isolation note: the manager analogue lives in
 * convex/conversations/managerConversations.ts on its OWN table.
 */

const NEW_CONVERSATION_TITLE = 'New conversation';

type ConversationFields = {
  id: string;
  spaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

/** The Conversation row shape the routes / page consume (lib/types Conversation
 *  minus the JS-side `preview`, which the caller assembles from messages). */
function toRow(c: ConversationFields) {
  return {
    id: c.id,
    spaceId: c.spaceId,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A space's conversations, newest-updated first (cap 50). Mirrors
 *  `.from('Conversation').eq('spaceId').order('updatedAt', desc)`. The caller
 *  drops reserved (manager/team) titles in memory. */
export const listBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Conversation')
      .withIndex('by_space_updated', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .take(50);
    return rows.map(toRow);
  },
});

/** One conversation by id, or null. Mirrors `.eq('id').maybeSingle()`. Returns
 *  the (id, spaceId, title) every guard needs plus timestamps. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('Conversation')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return c ? toRow(c) : null;
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/** Create a conversation. title defaults to 'New conversation' (PG default),
 *  createdAt/updatedAt = now. Returns the row (the POST route returns it as-is). */
export const create = mutation({
  args: { spaceId: v.string(), title: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      title: args.title ?? NEW_CONVERSATION_TITLE,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('Conversation', doc);
    return toRow(doc);
  },
});

/**
 * Resolve a conversation for a turn: accept the given id ONLY when it belongs to
 * this space; otherwise create a fresh one. Mirrors resolveConversation() in
 * app/api/ai/task/route.ts — but the reserved-title rejection stays in the route
 * (it owns the lib/chat/conversation-access check). This returns enough for the
 * caller to make that decision and to know whether a fresh row was minted.
 *
 * Returns { id, title, created }:
 *   - existing match (same spaceId): the row's id+title, created=false. The
 *     route then applies its reserved-title guard and auto-title trigger.
 *   - no match / foreign space / missing: a NEW conversation, created=true.
 */
export const resolveForTurn = mutation({
  args: { spaceId: v.string(), conversationId: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ id: string; title: string; created: boolean }> => {
    if (args.conversationId !== null) {
      const existing = await ctx.db
        .query('Conversation')
        .withIndex('by_app_id', (q) => q.eq('id', args.conversationId as string))
        .unique();
      if (existing && existing.spaceId === args.spaceId) {
        return { id: existing.id, title: existing.title, created: false };
      }
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await ctx.db.insert('Conversation', {
      id,
      spaceId: args.spaceId,
      title: NEW_CONVERSATION_TITLE,
      createdAt: now,
      updatedAt: now,
    });
    return { id, title: NEW_CONVERSATION_TITLE, created: true };
  },
});

/** Rename a conversation, bumping updatedAt. Scoped to (id) — the route already
 *  verified ownership. Returns the updated row (PATCH route returns it), or null
 *  if the row vanished. Mirrors `.update({ title, updatedAt }).eq('id')`. */
export const rename = mutation({
  args: { id: v.string(), title: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('Conversation')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c) return null;
    await ctx.db.patch(c._id, { title: args.title, updatedAt: new Date().toISOString() });
    return toRow((await ctx.db.get(c._id))!);
  },
});

/**
 * Set a conversation's title + updatedAt, scoped to (id, spaceId). The
 * auto-title pipeline in app/api/ai/task/route.ts patches by both id AND spaceId
 * (`.eq('id').eq('spaceId')`), so a foreign space can't rename. No-op if the row
 * doesn't match. Distinct from `rename` (which is id-only, post-ownership-check).
 */
export const setTitleForSpace = mutation({
  args: { id: v.string(), spaceId: v.string(), title: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const c = await ctx.db
      .query('Conversation')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c || c.spaceId !== args.spaceId) return;
    await ctx.db.patch(c._id, { title: args.title, updatedAt: new Date().toISOString() });
  },
});

/**
 * Delete a conversation, scoped to (id, spaceId) — mirrors the seller DELETE
 * route's `.delete().eq('id').eq('spaceId')`. The old route issues a bare
 * single-row delete and does NOT cascade Message rows, so this matches that
 * behavior exactly (Message rows are left; they're filtered by conversationId
 * and a deleted conversation is simply unreachable from the list). No-op if the
 * row doesn't match the space.
 */
export const deleteForSpace = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const c = await ctx.db
      .query('Conversation')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c || c.spaceId !== args.spaceId) return;
    await ctx.db.delete(c._id);
  },
});
