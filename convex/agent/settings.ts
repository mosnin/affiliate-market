import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * AgentSettings data access — the Convex replacement for the `.from('AgentSettings')`
 * reads & writes: the settings GET/PATCH and the budget reads in
 * usage / ai-task / manager-task / swarm + the workspace-model load.
 *
 * UNIQUE(spaceId) — one settings row per space — is preserved as a read-by-space
 * -then-patch-or-insert upsert inside ONE serializable mutation (the PATCH route
 * upserted on spaceId). Reads default missing rows to the same fallbacks the call
 * sites applied (enabled=false, dailyTokenBudget=50000, chatModel=null).
 */

const DEFAULT_DAILY_TOKEN_BUDGET = 50000;

function toSettingsRow(s: Doc<'AgentSettings'>) {
  return {
    id: s.id,
    spaceId: s.spaceId,
    enabled: s.enabled,
    dailyTokenBudget: s.dailyTokenBudget,
    chatModel: s.chatModel ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The settings row for a space, or null if none exists. Mirrors
 *  `.eq('spaceId').maybeSingle()` selecting (spaceId, enabled, dailyTokenBudget,
 *  chatModel). The lib applies the default object when null (settings GET). */
export const getBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('AgentSettings')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    return s ? toSettingsRow(s) : null;
  },
});

/** The space's daily token budget, defaulting to 50000 when no row exists.
 *  Folds the `.maybeSingle()` + `?? 50000` pattern repeated across the budget
 *  checks (usage, ai-task, manager-task, swarm) into one query. */
export const dailyTokenBudget = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const s = await ctx.db
      .query('AgentSettings')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    return s?.dailyTokenBudget ?? DEFAULT_DAILY_TOKEN_BUDGET;
  },
});

/** The space's chat-model override, or null (ai-task loadWorkspaceModel). The lib
 *  falls back to DEFAULT_CHAT_MODEL when null. */
export const chatModel = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const s = await ctx.db
      .query('AgentSettings')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    return s?.chatModel ?? null;
  },
});

// ── Write (upsert) ────────────────────────────────────────────────────────────

/**
 * Upsert the space's settings (PATCH). UNIQUE(spaceId): read the existing row,
 * then patch it or insert a fresh one — serializable in one mutation, so the old
 * upsert's race window is gone. Only the provided fields change:
 *   - enabled / dailyTokenBudget: patched when present.
 *   - chatModel: present-and-string sets it; present-and-null CLEARS it (the
 *     route used null to drop the override); absent leaves it untouched.
 * New rows take PG defaults for anything not supplied (enabled=false,
 * dailyTokenBudget=50000). Returns the resulting row (the route selected
 * spaceId/enabled/dailyTokenBudget/chatModel).
 */
export const upsert = mutation({
  args: {
    spaceId: v.string(),
    enabled: v.optional(v.boolean()),
    dailyTokenBudget: v.optional(v.number()),
    // chatModel tri-state: undefined = leave, null = clear, string = set.
    chatModel: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const existing = await ctx.db
      .query('AgentSettings')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();

    if (existing) {
      const patch: Record<string, unknown> = { updatedAt: now };
      if (args.enabled !== undefined) patch.enabled = args.enabled;
      if (args.dailyTokenBudget !== undefined) patch.dailyTokenBudget = args.dailyTokenBudget;
      if (args.chatModel !== undefined) patch.chatModel = args.chatModel ?? undefined; // null clears
      await ctx.db.patch(existing._id, patch);
      const updated = (await ctx.db.get(existing._id))!;
      return toSettingsRow(updated);
    }

    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      enabled: args.enabled ?? false,
      dailyTokenBudget: args.dailyTokenBudget ?? DEFAULT_DAILY_TOKEN_BUDGET,
      ...(args.chatModel != null ? { chatModel: args.chatModel } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('AgentSettings', doc);
    return toSettingsRow(doc as Doc<'AgentSettings'>);
  },
});
