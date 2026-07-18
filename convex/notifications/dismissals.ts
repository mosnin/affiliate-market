import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * AnnouncementDismissal data access — Convex replacement for the Supabase reads/
 * writes in app/api/platform/announcements/route.ts (which announcement ids a
 * user has dismissed) and app/api/platform/announcements/dismiss/route.ts (record
 * a dismissal).
 *
 * Invariant carried from Postgres: UNIQUE(announcementId, userId). Convex has no
 * unique constraint, so `dismiss` re-implements it as read-then-insert inside one
 * serializable mutation (matching the old upsert with ignoreDuplicates).
 */

/**
 * The announcement ids this user has dismissed, restricted to a candidate set.
 * Replaces `.select('announcementId').eq('userId', userId).in('announcementId', ids)`
 * in the platform GET. We read all the user's dismissals off `by_user` and filter
 * to the candidate ids in the handler (a user's dismissal count is small).
 */
export const dismissedIdsForUser = query({
  args: { userId: v.string(), announcementIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<string[]> => {
    const candidates = new Set(args.announcementIds);
    const rows = await ctx.db
      .query('AnnouncementDismissal')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    return rows.map((r) => r.announcementId).filter((id) => candidates.has(id));
  },
});

/**
 * Record a dismissal for (announcementId, userId). Idempotent: a repeat dismiss
 * is a no-op (preserving UNIQUE(announcementId, userId)). Replaces the
 * `.upsert({...}, { onConflict: 'announcementId,userId', ignoreDuplicates: true })`
 * in the dismiss POST route.
 */
export const dismiss = mutation({
  args: { announcementId: v.string(), userId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query('AnnouncementDismissal')
      .withIndex('by_announcement_user', (q) =>
        q.eq('announcementId', args.announcementId).eq('userId', args.userId),
      )
      .unique();
    if (existing) return;
    await ctx.db.insert('AnnouncementDismissal', {
      id: crypto.randomUUID(),
      announcementId: args.announcementId,
      userId: args.userId,
      dismissedAt: new Date().toISOString(),
    });
  },
});
