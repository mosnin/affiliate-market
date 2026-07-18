import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ManagerMessage data access (MANAGER surface) — the Convex replacement for the
 * `.from('ManagerMessage')` reads & writes in lib/agent/manager-persistence.ts,
 * app/api/ai/manager-messages/route.ts, app/api/ai/manager-task/route.ts,
 * app/api/ai/manager-conversations/route.ts (preview), and app/manager/page.tsx.
 *
 * The manager analogue of convex/conversations/messages.ts — structurally
 * isolated by living in its OWN table keyed by companyId + conversationId. The
 * content-coalescing + content-derivation stays in lib (manager-persistence);
 * this module writes the already-shaped row and reads it back.
 *
 * After a save, the lib bumps the parent ManagerConversation.updatedAt via
 * managerConversations.touch — that stays a separate lib hop (cross-module
 * ordering is cosmetic and the old code did it as a second statement too).
 */

type ManagerMessageFields = {
  id: string;
  role: string;
  content: string;
  blocks?: unknown;
  createdAt: string;
};

function toTranscriptRow(m: ManagerMessageFields) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    blocks: m.blocks ?? null,
    createdAt: m.createdAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Messages for a manager conversation, oldest-first (cap `limit`, default 50).
 * Mirrors `.from('ManagerMessage').eq('conversationId').order('createdAt', asc)
 * .limit(50)` (the /api/ai/manager-messages GET and the /manager page hydrate).
 */
export const listForConversation = query({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ManagerMessage')
      .withIndex('by_conversation_created', (q) => q.eq('conversationId', args.conversationId))
      .order('asc')
      .take(args.limit ?? 50);
    return rows.map(toTranscriptRow);
  },
});

/**
 * Recent history for a manager turn — newest `limit` (default 8) for a
 * conversation, returned chronological. Mirrors loadHistory() in
 * app/api/ai/manager-task/route.ts (`order('createdAt', desc).limit(8)` then
 * `.reverse()`). Returns (role, content) only.
 */
export const loadHistory = query({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Array<{ role: string; content: string }>> => {
    const rows = await ctx.db
      .query('ManagerMessage')
      .withIndex('by_conversation_created', (q) => q.eq('conversationId', args.conversationId))
      .order('desc')
      .take(args.limit ?? 8);
    return rows.reverse().map((m) => ({ role: m.role, content: m.content }));
  },
});

/**
 * Latest message content per manager conversation, for the sidebar preview line.
 * Mirrors the `.in('conversationId', ids).order('createdAt', desc)` + "first row
 * per id wins" dedup in the manager-conversations list route. Returns a
 * { [conversationId]: content } map; the caller collapses whitespace + truncates.
 */
export const latestPreviewContent = query({
  args: { conversationIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const cid of args.conversationIds) {
      const latest = await ctx.db
        .query('ManagerMessage')
        .withIndex('by_conversation_created', (q) => q.eq('conversationId', cid))
        .order('desc')
        .first();
      if (latest) out[cid] = latest.content;
    }
    return out;
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Save a manager user message. Mirrors saveManagerUserMessage() in
 * lib/agent/manager-persistence.ts (`.insert({ id, companyId, conversationId,
 * role:'user', content })`). conversationId is NOT NULL here. Returns the new id.
 * (The lib then calls managerConversations.touch separately.)
 */
export const saveUserMessage = mutation({
  args: { companyId: v.string(), conversationId: v.string(), content: v.string() },
  handler: async (ctx, args): Promise<{ messageId: string }> => {
    const id = crypto.randomUUID();
    await ctx.db.insert('ManagerMessage', {
      id,
      companyId: args.companyId,
      conversationId: args.conversationId,
      role: 'user',
      content: args.content,
      createdAt: new Date().toISOString(),
    });
    return { messageId: id };
  },
});

/**
 * Save a manager assistant message with its `blocks`. Mirrors
 * saveManagerAssistantMessage() (`.insert({ id, companyId, conversationId,
 * role:'assistant', content, blocks })`). The lib derives content (placeholder
 * for tool-only turns) and coalesces blocks. Returns the new id.
 */
export const saveAssistantMessage = mutation({
  args: {
    companyId: v.string(),
    conversationId: v.string(),
    content: v.string(),
    blocks: v.any(),
  },
  handler: async (ctx, args): Promise<{ messageId: string }> => {
    const id = crypto.randomUUID();
    await ctx.db.insert('ManagerMessage', {
      id,
      companyId: args.companyId,
      conversationId: args.conversationId,
      role: 'assistant',
      content: args.content,
      blocks: args.blocks,
      createdAt: new Date().toISOString(),
    });
    return { messageId: id };
  },
});
