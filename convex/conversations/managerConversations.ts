import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ManagerConversation data access (MANAGER surface) — the Convex replacement for
 * the `.from('ManagerConversation')` reads & writes in
 * app/api/ai/manager-conversations/**, app/api/ai/manager-task/route.ts, and
 * app/manager/page.tsx.
 *
 * STORAGE IS STRUCTURALLY SEPARATE. Manager conversations live in their OWN
 * table keyed by `companyId` — NOT a Space, NOT a title prefix. The companyId
 * column IS the boundary, so a seller surface can never enumerate one: the rows
 * are not in its table. Every read/write here is scoped by companyId.
 *
 * CASCADE: deleting a ManagerConversation removes its ManagerMessage rows. PG had
 * an ON DELETE CASCADE on the ManagerMessage.conversationId FK (the route relies
 * on it). Convex has no FK cascade, so `deleteForCompany` deletes the messages
 * explicitly inside the same (serializable) mutation.
 */

const NEW_CONVERSATION_TITLE = 'New conversation';

type ManagerConversationFields = {
  id: string;
  companyId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

function toRow(c: ManagerConversationFields) {
  return {
    id: c.id,
    companyId: c.companyId,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A company's manager conversations, newest-updated first (cap 50). Mirrors
 *  `.from('ManagerConversation').eq('companyId').order('updatedAt', desc).limit(50)`. */
export const listByCompany = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ManagerConversation')
      .withIndex('by_company_updated', (q) => q.eq('companyId', args.companyId))
      .order('desc')
      .take(50);
    return rows.map(toRow);
  },
});

/** One manager conversation by id, or null. Mirrors `.eq('id').maybeSingle()`.
 *  The caller compares companyId for the ownership gate. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('ManagerConversation')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return c ? toRow(c) : null;
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/** Create a manager conversation. title defaults to 'New conversation', now for
 *  timestamps. Returns the row (POST route returns it as-is). */
export const create = mutation({
  args: { companyId: v.string(), title: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      companyId: args.companyId,
      title: args.title ?? NEW_CONVERSATION_TITLE,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('ManagerConversation', doc);
    return toRow(doc);
  },
});

/**
 * Resolve a manager conversation for a turn: accept the given id ONLY when its
 * companyId matches; otherwise create a fresh one. Mirrors resolveConversation()
 * in app/api/ai/manager-task/route.ts (companyId is the only boundary — no
 * spaceId, no title prefix). Returns { id, created }.
 */
export const resolveForTurn = mutation({
  args: { companyId: v.string(), conversationId: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ id: string; created: boolean }> => {
    if (args.conversationId !== null) {
      const existing = await ctx.db
        .query('ManagerConversation')
        .withIndex('by_app_id', (q) => q.eq('id', args.conversationId as string))
        .unique();
      if (existing && existing.companyId === args.companyId) {
        return { id: existing.id, created: false };
      }
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await ctx.db.insert('ManagerConversation', {
      id,
      companyId: args.companyId,
      title: NEW_CONVERSATION_TITLE,
      createdAt: now,
      updatedAt: now,
    });
    return { id, created: true };
  },
});

/**
 * Bump a conversation's updatedAt so the sidebar orders by recency. Mirrors
 * touchConversation() in lib/agent/manager-persistence.ts
 * (`.update({ updatedAt }).eq('id')`). No-op if the row vanished (the lib treats
 * touch failures as non-fatal — ordering is cosmetic).
 */
export const touch = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const c = await ctx.db
      .query('ManagerConversation')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c) return;
    await ctx.db.patch(c._id, { updatedAt: new Date().toISOString() });
  },
});

/**
 * Rename a manager conversation, bumping updatedAt, scoped to (id, companyId) —
 * mirrors the PATCH route's `.update({ title, updatedAt }).eq('id').eq('companyId')`.
 * Returns the updated row, or null if it doesn't match the company (the route
 * already pre-checked ownership, so null means a concurrent delete).
 */
export const rename = mutation({
  args: { id: v.string(), companyId: v.string(), title: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('ManagerConversation')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c || c.companyId !== args.companyId) return null;
    await ctx.db.patch(c._id, { title: args.title, updatedAt: new Date().toISOString() });
    return toRow((await ctx.db.get(c._id))!);
  },
});

/**
 * Delete a manager conversation AND its messages, scoped to (id, companyId).
 * Mirrors the DELETE route's `.delete().eq('id').eq('companyId')` — but Postgres
 * cascaded the ManagerMessage rows via the conversationId FK, so we delete them
 * explicitly here inside one mutation. No-op if the row doesn't match the company.
 */
export const deleteForCompany = mutation({
  args: { id: v.string(), companyId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const c = await ctx.db
      .query('ManagerConversation')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c || c.companyId !== args.companyId) return;

    // Cascade: remove the conversation's messages (PG ON DELETE CASCADE).
    const messages = await ctx.db
      .query('ManagerMessage')
      .withIndex('by_conversation_created', (q) => q.eq('conversationId', c.id))
      .collect();
    for (const m of messages) await ctx.db.delete(m._id);

    await ctx.db.delete(c._id);
  },
});
