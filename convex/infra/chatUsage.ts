import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * ChatUsage data access — the Convex replacement for `.from('ChatUsage')` in
 * lib/usage/record-chat-usage.ts (the writer), lib/usage/today-token-usage.ts,
 * GET /api/agent/usage, app/manager/usage/page.tsx, and scripts/measure-chat-cost.ts.
 * Per-turn LLM token/cost telemetry.
 *
 * costUsd is a fractional USD amount (numeric(10,6)), NOT integer cents — stored
 * verbatim. The pricing math (calculateCost) and provider detection live in
 * lib/usage and lib/llm; this module never recomputes them — the caller passes
 * the already-computed costUsd + provider, exactly as the old insert did.
 *
 * ⚠️ CROSS-DOMAIN CREDITS TRIGGER (flagged — NOT handled here):
 * the old Postgres schema fired `charge_credits_for_chat_usage` AFTER INSERT ON
 * "ChatUsage", which drained the space's CreditLot rows (FIFO, soonest-expiring
 * first, floored at 0) to bill the turn. No application code did this — it was a
 * pure DB trigger. Convex has no triggers, and CreditLot is the CREDITS domain
 * (owned by a different agent), so folding a credits write into `insert` would
 * break the parallel-split rule (CONVENTIONS: swap only your own tables; keep
 * cross-domain orchestration in lib). The integrator MUST re-attach the charge
 * as a lib→lib call around recordChatUsage — e.g. after `convex.mutation(insert)`,
 * call the credits domain's spend function with the same model→credits formula
 * (GREATEST(1, CEIL(costUsd / 0.013))). Until then, turns are recorded but NOT
 * billed. This is the single behavioral gap in the infra cutover — call it out.
 */

type ChatUsageFields = {
  id: string;
  spaceId: string;
  userId?: string;
  conversationId?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  runtime: string;
  createdAt: string;
  cachedTokens: number;
  provider: string;
  route: string;
};

/** Full ChatUsage row; optionals -> null. */
function toRow(u: ChatUsageFields) {
  return {
    id: u.id,
    spaceId: u.spaceId,
    userId: u.userId ?? null,
    conversationId: u.conversationId ?? null,
    model: u.model,
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    costUsd: u.costUsd,
    runtime: u.runtime,
    createdAt: u.createdAt,
    cachedTokens: u.cachedTokens,
    provider: u.provider,
    route: u.route,
  };
}

// ── Write ────────────────────────────────────────────────────────────────────

/** recordChatUsage(): insert one usage row. Mirrors lib/usage/record-chat-usage.ts's
 *  `.insert({ spaceId, userId, conversationId, model, promptTokens,
 *  completionTokens, cachedTokens, provider, route, costUsd, runtime })`. The
 *  lib already floors/clamps tokens, detects provider, and computes costUsd; the
 *  zero-token short-circuit also stays in lib. runtime defaults to 'modal' (PG
 *  default) when omitted, matching the column default — though the lib always
 *  passes one. See the header note on the credits trigger this insert no longer
 *  fires. */
export const insert = mutation({
  args: {
    spaceId: v.string(),
    userId: v.union(v.string(), v.null()),
    conversationId: v.union(v.string(), v.null()),
    model: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    cachedTokens: v.number(),
    provider: v.string(),
    route: v.string(),
    costUsd: v.number(),
    runtime: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('ChatUsage', {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      ...(args.userId !== null ? { userId: args.userId } : {}),
      ...(args.conversationId !== null ? { conversationId: args.conversationId } : {}),
      model: args.model,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      cachedTokens: args.cachedTokens,
      provider: args.provider,
      route: args.route,
      costUsd: args.costUsd,
      runtime: args.runtime ?? 'modal',
      createdAt: new Date().toISOString(),
    });
  },
});

// ── Reads ────────────────────────────────────────────────────────────────────

/** getTodayTokenUsage(): a space's (promptTokens, completionTokens) since a
 *  cutoff (UTC midnight). Mirrors `.select('promptTokens, completionTokens')
 *  .eq('spaceId').gte('createdAt', since)`. Returns the rows so the lib sums them
 *  (then adds the Redis autonomous figure) exactly as before. */
export const tokensForSpaceSince = query({
  args: { spaceId: v.string(), since: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ promptTokens: number; completionTokens: number }[]> => {
    const rows = await ctx.db
      .query('ChatUsage')
      .withIndex('by_space_created', (q) =>
        q.eq('spaceId', args.spaceId).gte('createdAt', args.since),
      )
      .collect();
    return rows.map((r) => ({
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
    }));
  },
});

/** GET /api/agent/usage (7-day provider breakdown for one space). Mirrors
 *  `.select('provider, promptTokens, completionTokens, cachedTokens')
 *  .eq('spaceId').gte('createdAt', sevenDaysAgo)`. The route rolls up per
 *  provider + cache-hit-rate. */
export const providerRowsForSpaceSince = query({
  args: { spaceId: v.string(), since: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ChatUsage')
      .withIndex('by_space_created', (q) =>
        q.eq('spaceId', args.spaceId).gte('createdAt', args.since),
      )
      .collect();
    return rows.map((r) => ({
      provider: r.provider,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      cachedTokens: r.cachedTokens,
    }));
  },
});

/** manager/usage (company-wide, this month): rows for any of `spaceIds` since a
 *  cutoff. Mirrors `.select('spaceId, provider, promptTokens, completionTokens,
 *  cachedTokens, costUsd').in('spaceId', spaceIds).gte('createdAt', monthStart)`.
 *  The lib expands the IN-set (single-value withIndex) and does the per-seller +
 *  per-provider rollup. */
export const rowsForSpacesSince = query({
  args: { spaceIds: v.array(v.string()), since: v.string() },
  handler: async (ctx, args) => {
    const out: {
      spaceId: string;
      provider: string;
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      costUsd: number;
    }[] = [];
    for (const spaceId of args.spaceIds) {
      const rows = await ctx.db
        .query('ChatUsage')
        .withIndex('by_space_created', (q) =>
          q.eq('spaceId', spaceId).gte('createdAt', args.since),
        )
        .collect();
      for (const r of rows) {
        out.push({
          spaceId: r.spaceId,
          provider: r.provider,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          cachedTokens: r.cachedTokens,
          costUsd: r.costUsd,
        });
      }
    }
    return out;
  },
});

/** scripts/measure-chat-cost.ts: every row since a cutoff, across all spaces,
 *  newest-first. Mirrors the paginated `.select(...).gte('createdAt', sinceIso)
 *  .order(createdAt desc)` scan (PG had no createdAt-only index — a full scan
 *  there too). Returns the full rows the script aggregates; the script's own
 *  pagination collapses into this single collect. */
export const allSince = query({
  args: { since: v.string() },
  handler: async (ctx, args) => {
    const rows: Doc<'ChatUsage'>[] = await ctx.db.query('ChatUsage').collect();
    return rows
      .filter((r) => r.createdAt >= args.since)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map(toRow);
  },
});
