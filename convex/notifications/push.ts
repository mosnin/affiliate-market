import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * PushSubscription data access — Convex replacement for the Supabase reads/
 * writes in lib/push.ts (sendPushToSpace) and app/api/push/subscribe/route.ts
 * (POST upsert / DELETE by endpoint).
 *
 * Invariant carried from Postgres: UNIQUE(endpoint). Convex has no unique
 * constraint, so `upsert` re-implements it as read-by-endpoint-then-patch-or-
 * insert inside one serializable mutation.
 */

/** Shape lib/push.ts#SubscriptionRow consumes for a send: id/endpoint/p256dh/auth. */
function toSendRow(doc: Doc<'PushSubscription'>) {
  return { id: doc.id, endpoint: doc.endpoint, p256dh: doc.p256dh, auth: doc.auth };
}

/**
 * Every subscription for a space (id, endpoint, p256dh, auth). Replaces
 * `.select('id, endpoint, p256dh, auth').eq('spaceId', spaceId)` in sendPushToSpace.
 */
export const listBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('PushSubscription')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.map(toSendRow);
  },
});

/**
 * Upsert a browser subscription keyed on endpoint (UNIQUE in PG). A re-subscribe
 * from the same browser overwrites the stored keys/space/user in place rather
 * than inserting a duplicate. `userId`/`userAgent` are optional (SQL-nullable);
 * omitted when absent. Replaces the `.upsert({...}, { onConflict: 'endpoint' })`
 * in the subscribe POST route.
 */
export const upsert = mutation({
  args: {
    spaceId: v.string(),
    userId: v.optional(v.string()),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query('PushSubscription')
      .withIndex('by_endpoint', (q) => q.eq('endpoint', args.endpoint))
      .unique();

    const fields = {
      spaceId: args.spaceId,
      ...(args.userId !== undefined ? { userId: args.userId } : {}),
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      ...(args.userAgent !== undefined ? { userAgent: args.userAgent } : {}),
    };

    if (existing) {
      // Overwrite the conflicting row in place (the old onConflict: 'endpoint'
      // upsert replaced every supplied column). Patch can't remove a column, so
      // clear userId/userAgent explicitly when this re-subscribe omits them.
      await ctx.db.patch(existing._id, {
        ...fields,
        userId: args.userId,
        userAgent: args.userAgent,
      });
      return;
    }

    await ctx.db.insert('PushSubscription', {
      id: crypto.randomUUID(),
      ...fields,
      createdAt: new Date().toISOString(),
    });
  },
});

/**
 * Delete a subscription by (spaceId, endpoint). Replaces
 * `.delete().eq('spaceId').eq('endpoint')` in the subscribe DELETE route. The
 * spaceId guard scopes the delete to the caller's space (endpoint is globally
 * unique, so at most one row matches).
 */
export const deleteByEndpoint = mutation({
  args: { spaceId: v.string(), endpoint: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query('PushSubscription')
      .withIndex('by_endpoint', (q) => q.eq('endpoint', args.endpoint))
      .unique();
    if (existing && existing.spaceId === args.spaceId) {
      await ctx.db.delete(existing._id);
    }
  },
});

/**
 * Prune dead subscriptions by their string ids (404/410 from the push service).
 * Replaces `.delete().in('id', dead)` in sendPushToSpace. Looks each up on
 * by_app_id and deletes it; missing ids are skipped.
 */
export const deleteByIds = mutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    for (const id of args.ids) {
      const row = await ctx.db
        .query('PushSubscription')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (row) await ctx.db.delete(row._id);
    }
  },
});
