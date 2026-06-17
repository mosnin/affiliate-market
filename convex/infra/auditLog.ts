import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * AuditLog data access — the Convex replacement for `.from('AuditLog')` in
 * lib/audit.ts (the writer), the admin audit-log page (newest 200), and the
 * manager activity page + route (company-scoped, paginated).
 *
 * Append-mostly: one fire-and-forget insert per audited operation, plus
 * filtered reads. The manager activity route runs TWO queries (space-scoped +
 * null-space-with metadata.companyId) and merges/dedupes/keyset-paginates them
 * while joining User + Space — all cross-table orchestration that STAYS IN LIB
 * (CONVENTIONS). These functions provide the two filtered reads it composes.
 */

type AuditFields = {
  id: string;
  clerkId?: string;
  actorId?: string;
  ipAddress?: string;
  action: string;
  resource: string;
  resourceId?: string;
  spaceId?: string;
  metadata?: unknown;
  createdAt: string;
};

/** The row shape the activity pages + admin page read. Optionals -> null. */
function toAuditRow(a: AuditFields) {
  return {
    id: a.id,
    clerkId: a.clerkId ?? null,
    ipAddress: a.ipAddress ?? null,
    action: a.action,
    resource: a.resource,
    resourceId: a.resourceId ?? null,
    spaceId: a.spaceId ?? null,
    metadata: a.metadata ?? null,
    createdAt: a.createdAt,
  };
}

// ── Write ────────────────────────────────────────────────────────────────────

/** Insert one audit row (fire-and-forget). Mirrors lib/audit.ts#audit's
 *  `.insert({ id, clerkId, ipAddress, action, resource, resourceId, spaceId,
 *  metadata })`. Nullable fields are passed explicitly as null by the caller;
 *  we store them only when present (absent ⇔ SQL NULL). */
export const insert = mutation({
  args: {
    clerkId: v.union(v.string(), v.null()),
    ipAddress: v.union(v.string(), v.null()),
    action: v.string(),
    resource: v.string(),
    resourceId: v.union(v.string(), v.null()),
    spaceId: v.union(v.string(), v.null()),
    metadata: v.union(v.any(), v.null()),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('AuditLog', {
      id: crypto.randomUUID(),
      ...(args.clerkId !== null ? { clerkId: args.clerkId } : {}),
      ...(args.ipAddress !== null ? { ipAddress: args.ipAddress } : {}),
      action: args.action,
      resource: args.resource,
      ...(args.resourceId !== null ? { resourceId: args.resourceId } : {}),
      ...(args.spaceId !== null ? { spaceId: args.spaceId } : {}),
      ...(args.metadata !== null ? { metadata: args.metadata } : {}),
      createdAt: new Date().toISOString(),
    });
  },
});

// ── Reads ────────────────────────────────────────────────────────────────────

/** Admin audit-log page: newest `limit` rows across all spaces (default 200).
 *  Mirrors `.from('AuditLog').select('*').order(createdAt desc).limit(200)`.
 *  Uses insertion order (_creationTime) which tracks createdAt for an append
 *  log — no createdAt index needed for this unfiltered scan. */
export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query('AuditLog').order('desc').take(args.limit ?? 200);
    return rows.map(toAuditRow);
  },
});

/** Manager activity, slice A: rows for any of `spaceIds`, createdAt >= since,
 *  optional action + clerkId, optional keyset cursor (createdAt,id)<(ts,id),
 *  newest-first, capped at `limit`. Mirrors the route's Query A. The lib expands
 *  the spaceId IN-set (Convex withIndex is single-value) and does the final
 *  cross-query merge. Returns up to `limit` per space already trimmed.
 *
 *  Filtering/ordering is done in-handler over the by_space_created index so the
 *  exact PostgREST predicate is reproduced (incl. the tuple-cursor tie-break). */
export const listForSpacesScoped = query({
  args: {
    spaceIds: v.array(v.string()),
    since: v.string(),
    action: v.optional(v.string()),
    clerkId: v.optional(v.string()),
    cursorTs: v.optional(v.string()),
    cursorId: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const collected: Doc<'AuditLog'>[] = [];
    for (const spaceId of args.spaceIds) {
      const rows = await ctx.db
        .query('AuditLog')
        .withIndex('by_space_created', (q) =>
          q.eq('spaceId', spaceId).gte('createdAt', args.since),
        )
        .order('desc')
        .collect();
      collected.push(...rows);
    }
    return filterSortPage(collected, args).map(toAuditRow);
  },
});

/** Manager activity, slice B: null-space rows whose metadata.companyId matches,
 *  createdAt >= since, optional action + clerkId, optional keyset cursor,
 *  newest-first, capped. Mirrors the route's Query B (`.is('spaceId', null)
 *  .eq('metadata->>companyId', companyId)`). spaceId IS NULL has no index; this
 *  scans the table and filters — matching PG, where the jsonb path was the
 *  selective predicate and the route already treats this query as non-fatal. */
export const listNullSpaceForCompany = query({
  args: {
    companyId: v.string(),
    since: v.string(),
    action: v.optional(v.string()),
    clerkId: v.optional(v.string()),
    cursorTs: v.optional(v.string()),
    cursorId: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db.query('AuditLog').collect();
    const nullSpace = all.filter((r) => {
      if (r.spaceId != null) return false;
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      return meta.companyId === args.companyId;
    });
    return filterSortPage(nullSpace, args).map(toAuditRow);
  },
});

/** Shared: apply createdAt>=since, action, clerkId, the (createdAt,id) keyset
 *  cursor, sort newest-first (createdAt desc, id desc), trim to limit. Mirrors
 *  the PostgREST filters + ordering + over-fetch in both activity queries. */
function filterSortPage(
  rows: Doc<'AuditLog'>[],
  args: {
    since: string;
    action?: string;
    clerkId?: string;
    cursorTs?: string;
    cursorId?: string;
    limit: number;
  },
): Doc<'AuditLog'>[] {
  let out = rows.filter((r) => r.createdAt >= args.since);
  if (args.action !== undefined) out = out.filter((r) => r.action === args.action);
  if (args.clerkId !== undefined) out = out.filter((r) => r.clerkId === args.clerkId);
  if (args.cursorTs !== undefined && args.cursorId !== undefined) {
    // (createdAt, id) < (cursorTs, cursorId)
    out = out.filter(
      (r) =>
        r.createdAt < args.cursorTs! ||
        (r.createdAt === args.cursorTs! && r.id < args.cursorId!),
    );
  }
  out.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return out.slice(0, args.limit);
}
