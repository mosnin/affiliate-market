import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * Message data access (SELLER surface) — the Convex replacement for the
 * `.from('Message')` reads & writes in lib/ai-tools/persistence.ts,
 * app/api/ai/messages/route.ts, app/api/ai/task/route.ts, and
 * app/api/ai/conversations/route.ts (the per-conversation preview), plus the
 * /s/[slug]/cola page hydrate.
 *
 * The content-coalescing + content-derivation that produced `content` and
 * `blocks` stays in lib (lib/ai-tools/persistence + lib/ai-tools/blocks — pure
 * transforms). This module only writes the already-shaped row and reads it back.
 *
 * `blocks` is a jsonb array of MessageBlock (lib/ai-tools/blocks). On read it is
 * surfaced as-is (or null when absent) so the renderer / legacy readers behave
 * unchanged. conversationId is NULLABLE in PG (orphan / pre-threading rows).
 */

type MessageFields = {
  id: string;
  role: string;
  content: string;
  blocks?: unknown;
  createdAt: string;
};

/** The transcript row shape the message endpoints + page hydrate read
 *  (`id, role, content, blocks, createdAt`). blocks absent -> null. */
function toTranscriptRow(m: MessageFields) {
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
 * Messages for a conversation, oldest-first (cap `limit`, default 50). Mirrors
 * `.from('Message').eq('conversationId').order('createdAt', asc).limit(50)`
 * (the /api/ai/messages GET and the page hydrate, which also scopes by spaceId —
 * see listForConversationInSpace).
 */
export const listForConversation = query({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Message')
      .withIndex('by_conversation_created', (q) => q.eq('conversationId', args.conversationId))
      .order('asc')
      .take(args.limit ?? 50);
    return rows.map(toTranscriptRow);
  },
});

/**
 * Messages for a conversation scoped to a space, oldest-first (cap 50). Mirrors
 * the /s/[slug]/cola page hydrate `.eq('spaceId').eq('conversationId')
 * .order('createdAt', asc).limit(50)`. The compound index carries the order.
 */
export const listForConversationInSpace = query({
  args: { spaceId: v.string(), conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Message')
      .withIndex('by_space_conversation_created', (q) =>
        q.eq('spaceId', args.spaceId).eq('conversationId', args.conversationId),
      )
      .order('asc')
      .take(args.limit ?? 50);
    return rows.map(toTranscriptRow);
  },
});

/**
 * Recent history for a turn — newest `limit` messages (default 8) scoped to
 * (spaceId, conversationId), returned chronological (oldest-first). Mirrors
 * loadHistory() in app/api/ai/task/route.ts: PG used `order('createdAt', desc)
 * .limit(8)` then `.reverse()`. We take newest-first off the index then reverse,
 * returning only (role, content) for the model (the lib filters to user|assistant).
 */
export const loadHistory = query({
  args: { spaceId: v.string(), conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Array<{ role: string; content: string }>> => {
    const rows = await ctx.db
      .query('Message')
      .withIndex('by_space_conversation_created', (q) =>
        q.eq('spaceId', args.spaceId).eq('conversationId', args.conversationId),
      )
      .order('desc')
      .take(args.limit ?? 8);
    return rows.reverse().map((m) => ({ role: m.role, content: m.content }));
  },
});

/**
 * Latest message content per conversation, for the sidebar preview line. Mirrors
 * the `.from('Message').in('conversationId', ids).order('createdAt', desc)` +
 * JS-side "first row per conversationId wins" dedup in the conversations-list
 * routes. PostgREST had no GROUP BY; Convex doesn't either, so we resolve the
 * newest message per id here and return a { [conversationId]: content } map. The
 * caller still does the whitespace-collapse + 60-char truncation.
 */
export const latestPreviewContent = query({
  args: { conversationIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const cid of args.conversationIds) {
      const latest = await ctx.db
        .query('Message')
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
 * Save a user message. Mirrors saveUserMessage() in lib/ai-tools/persistence.ts
 * (`.from('Message').insert({ id, spaceId, conversationId, role:'user', content })`).
 * User messages carry no blocks. conversationId is nullable. Returns the new id.
 */
export const saveUserMessage = mutation({
  args: {
    spaceId: v.string(),
    conversationId: v.union(v.string(), v.null()),
    content: v.string(),
  },
  handler: async (ctx, args): Promise<{ messageId: string }> => {
    const id = crypto.randomUUID();
    await ctx.db.insert('Message', {
      id,
      spaceId: args.spaceId,
      ...(args.conversationId !== null ? { conversationId: args.conversationId } : {}),
      role: 'user',
      content: args.content,
      createdAt: new Date().toISOString(),
    });
    return { messageId: id };
  },
});

/**
 * Save an assistant message with its rich `blocks`. Mirrors
 * saveAssistantMessage() (`.insert({ id, spaceId, conversationId,
 * role:'assistant', content, blocks })`). The lib still coalesces blocks and
 * derives `content` (the placeholder for tool-only turns); this stores the
 * already-shaped values. Returns the new id.
 */
export const saveAssistantMessage = mutation({
  args: {
    spaceId: v.string(),
    conversationId: v.union(v.string(), v.null()),
    content: v.string(),
    blocks: v.any(),
  },
  handler: async (ctx, args): Promise<{ messageId: string }> => {
    const id = crypto.randomUUID();
    await ctx.db.insert('Message', {
      id,
      spaceId: args.spaceId,
      ...(args.conversationId !== null ? { conversationId: args.conversationId } : {}),
      role: 'assistant',
      content: args.content,
      blocks: args.blocks,
      createdAt: new Date().toISOString(),
    });
    return { messageId: id };
  },
});
