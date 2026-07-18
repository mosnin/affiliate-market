import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * AgentPausedRun data access — the Convex replacement for the `.from('AgentPausedRun')`
 * reads & writes: the resume route (load + lazy-expire + CAS resume), the
 * persist-on-interruption insert (lib/ai-tools/sdk-chat-stream), and the daily
 * cron sweep (bulk expire + hard-delete).
 *
 * The resume CAS (only one request may flip pending->resumed) is preserved as a
 * read-then-patch on status=='pending' inside one serializable mutation — the old
 * code used `.update().eq('status','pending').select('id')` and checked the
 * returned count.
 */

const pausedStatusValidator = v.union(
  v.literal('pending'),
  v.literal('resumed'),
  v.literal('cancelled'),
  v.literal('expired'),
);

function toPausedRow(p: Doc<'AgentPausedRun'>) {
  return {
    id: p.id,
    spaceId: p.spaceId,
    userId: p.userId,
    conversationId: p.conversationId ?? null,
    runState: p.runState,
    approvals: p.approvals ?? [],
    status: p.status,
    expiresAt: p.expiresAt ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One paused run by id, or null — the resume route load (it then scope-checks
 *  userId/status/expiry itself). Mirrors `.eq('id').maybeSingle()` selecting
 *  (id, spaceId, userId, conversationId, runState, approvals, status, expiresAt). */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AgentPausedRun')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return p ? toPausedRow(p) : null;
  },
});

// ── Writes ────────────────────────────────────────────────────────────────────

/** Persist a paused run on SDK interruption (sdk-chat-stream persistPausedRun).
 *  status='pending', approvals defaults to [] in PG (caller passes the extracted
 *  array). Returns the new row's id. */
export const create = mutation({
  args: {
    spaceId: v.string(),
    userId: v.string(),
    conversationId: v.union(v.string(), v.null()),
    runState: v.string(),
    approvals: v.any(),
    expiresAt: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<{ id: string }> => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await ctx.db.insert('AgentPausedRun', {
      id,
      spaceId: args.spaceId,
      userId: args.userId,
      ...(args.conversationId !== null ? { conversationId: args.conversationId } : {}),
      runState: args.runState,
      approvals: args.approvals ?? [],
      status: 'pending',
      ...(args.expiresAt !== null ? { expiresAt: args.expiresAt } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return { id };
  },
});

/** Lazy single-row expire on resume access (the resume route flips an expired-
 *  but-still-pending run to 'expired' when the seller returns past expiresAt).
 *  Mirrors `.update({ status:'expired' }).eq('id')`. */
export const markExpired = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const p = await ctx.db
      .query('AgentPausedRun')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p) return;
    await ctx.db.patch(p._id, { status: 'expired', updatedAt: new Date().toISOString() });
  },
});

export interface ResumeResult {
  /** 'resumed' = this call won the CAS (pending->resumed); 'lost' = already
   *  resumed/cancelled/expired (someone else won or it moved); 'missing'. */
  outcome: 'resumed' | 'lost' | 'missing';
}

/**
 * CAS the run pending->resumed (the resume route's anti-double-execution guard).
 * Only flips if status is still 'pending'; otherwise reports 'lost' so the caller
 * 409s instead of re-running the tool. Read-then-patch in one mutation.
 */
export const markResumed = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<ResumeResult> => {
    const p = await ctx.db
      .query('AgentPausedRun')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p) return { outcome: 'missing' };
    if (p.status !== 'pending') return { outcome: 'lost' };
    await ctx.db.patch(p._id, { status: 'resumed', updatedAt: new Date().toISOString() });
    return { outcome: 'resumed' };
  },
});

/**
 * Cron sweep — mark expired: flip every still-pending run past its expiresAt to
 * 'expired'. Mirrors `.update({ status:'expired', updatedAt }).eq('status','pending')
 * .lt('expiresAt', now).select('id')`. Returns the count flipped. Reads the
 * pending index then filters expiresAt < now (a run with no expiresAt never
 * expires, matching `lt` on NULL = no match).
 */
export const sweepExpire = mutation({
  args: { now: v.string() },
  handler: async (ctx, args): Promise<{ expired: number }> => {
    const pending = await ctx.db
      .query('AgentPausedRun')
      .withIndex('by_status', (q) => q.eq('status', 'pending'))
      .collect();
    let expired = 0;
    for (const p of pending) {
      if (p.expiresAt != null && p.expiresAt < args.now) {
        await ctx.db.patch(p._id, { status: 'expired', updatedAt: args.now });
        expired++;
      }
    }
    return { expired };
  },
});

/**
 * Cron sweep — hard-delete: remove every run created before `cutoff`, regardless
 * of status. Mirrors `.delete().lt('createdAt', cutoff).select('id')`. Returns
 * the count deleted.
 */
export const sweepDelete = mutation({
  args: { cutoff: v.string() },
  handler: async (ctx, args): Promise<{ deleted: number }> => {
    const old = await ctx.db
      .query('AgentPausedRun')
      .withIndex('by_created', (q) => q.lt('createdAt', args.cutoff))
      .collect();
    for (const p of old) await ctx.db.delete(p._id);
    return { deleted: old.length };
  },
});
