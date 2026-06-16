import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * EmailBroadcast data access — the Convex replacement for the Supabase insert in
 * app/api/admin/broadcast/route.ts and the "past broadcasts" read in
 * app/admin/broadcast/page.tsx. Insert-only audit log; nothing updates a row.
 *
 * The actual email sending (Resend), segmentation, and recipient counting stay
 * in the route; only the log write + the recent-list read move here.
 */

/** Past-broadcasts row shape the admin page maps over (subset of columns —
 *  body is not selected there). Coerce absent sentBy back to null. */
function toRow(b: Doc<'EmailBroadcast'>) {
  return {
    id: b.id,
    subject: b.subject,
    segment: b.segment,
    recipientCount: b.recipientCount,
    sentCount: b.sentCount,
    failedCount: b.failedCount,
    sentBy: b.sentBy ?? null,
    createdAt: b.createdAt,
  };
}

/**
 * Log a broadcast send. The caller mints the id (it's also the audit target),
 * so we accept and store it rather than generate one. `sentBy` is optional
 * (nullable in PG). Returns nothing — the route already holds the id.
 */
export const create = mutation({
  args: {
    id: v.string(),
    subject: v.string(),
    body: v.string(),
    segment: v.string(),
    recipientCount: v.number(),
    sentCount: v.number(),
    failedCount: v.number(),
    sentBy: v.union(v.string(), v.null()),
    createdAt: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('EmailBroadcast', {
      id: args.id,
      subject: args.subject,
      body: args.body,
      segment: args.segment,
      recipientCount: args.recipientCount,
      sentCount: args.sentCount,
      failedCount: args.failedCount,
      ...(args.sentBy !== null ? { sentBy: args.sentBy } : {}),
      createdAt: args.createdAt,
    });
  },
});

/**
 * The N most recent broadcasts, newest first. Replaces the admin page's
 * `.select('id, subject, segment, recipientCount, sentCount, failedCount, sentBy, createdAt')
 *  .order('createdAt', desc).limit(20)`.
 */
export const listRecent = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('EmailBroadcast')
      .withIndex('by_created')
      .order('desc')
      .take(args.limit);
    return rows.map(toRow);
  },
});
