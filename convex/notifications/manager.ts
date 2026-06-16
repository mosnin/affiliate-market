import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * ManagerNotification data access — Convex replacement for the Supabase reads/
 * writes in lib/manager-notify.ts, app/api/manager/notifications/route.ts, and
 * the SLA-escalation count in app/manager/brief/page.tsx.
 *
 * `type` is a free-text column (no PG CHECK); the lib layer constrains it to its
 * TS union. `metadata` is jsonb (nullable) and surfaces as `null` when absent so
 * the old Row shape is preserved.
 */

/** Legacy ManagerNotification row shape (drop _id/_creationTime, surface `id`,
 *  coerce absent optionals back to the SQL NULLs callers expect). */
function toRow(doc: Doc<'ManagerNotification'>) {
  return {
    id: doc.id,
    companyId: doc.companyId,
    type: doc.type,
    title: doc.title,
    body: doc.body ?? null,
    metadata: doc.metadata ?? null,
    read: doc.read,
    createdAt: doc.createdAt,
  };
}

/**
 * Latest notifications for a company, newest first. Replaces the
 * `.select('*').eq('companyId').order('createdAt', desc).limit(20)` read in the
 * notifications GET route. `by_company` is (companyId, createdAt); ordering it
 * descending gives newest-first.
 */
export const listByCompany = query({
  args: { companyId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ManagerNotification')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .order('desc')
      .take(args.limit ?? 20);
    return rows.map(toRow);
  },
});

/**
 * Insert a notification (notifyManager). `body`/`metadata` are optional and are
 * omitted (not stored as null) when absent, matching how Convex represents SQL
 * NULL; `read` defaults to false like the old column default.
 */
export const create = mutation({
  args: {
    companyId: v.string(),
    type: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('ManagerNotification', {
      id: crypto.randomUUID(),
      companyId: args.companyId,
      type: args.type,
      title: args.title,
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      read: false,
      createdAt: new Date().toISOString(),
    });
  },
});

/**
 * Mark every unread notification for a company as read. Replaces the
 * `.update({ read: true }).eq('companyId').eq('read', false)` bulk write in the
 * notifications PATCH route. Convex has no bulk UPDATE, so we scan the
 * (companyId, read=false) index and patch each row.
 *
 * NOTE: the unread set is bounded by a single company's bell backlog (tens, not
 * millions); patching each is fine here. If a company could accumulate a very
 * large unread count this would want pagination/batching.
 */
export const markAllRead = mutation({
  args: { companyId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const unread = await ctx.db
      .query('ManagerNotification')
      .withIndex('by_company_read', (q) => q.eq('companyId', args.companyId).eq('read', false))
      .collect();
    for (const row of unread) {
      await ctx.db.patch(row._id, { read: true });
    }
  },
});

/**
 * Count escalation notifications Cola created today for a company. Replaces the
 * brief page's count read:
 *   .eq('companyId').eq('type','review_requested').gte('createdAt', todayStart)
 *   .filter('metadata->>kind', 'eq', 'lead_sla_breach')
 * The jsonb `metadata->>kind` filter has no index equivalent; we run the
 * createdAt range on `by_company` then filter type + metadata.kind in the handler.
 */
export const countEscalatedSince = query({
  args: {
    companyId: v.string(),
    type: v.string(),
    sinceCreatedAt: v.string(),
    metadataKind: v.string(),
  },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('ManagerNotification')
      .withIndex('by_company', (q) =>
        q.eq('companyId', args.companyId).gte('createdAt', args.sinceCreatedAt),
      )
      .collect();
    return rows.filter(
      (r) =>
        r.type === args.type &&
        ((r.metadata as { kind?: unknown } | null | undefined)?.kind ?? null) ===
          args.metadataKind,
    ).length;
  },
});
