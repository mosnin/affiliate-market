import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * CmaReport data access — the Convex replacement for the `.from('CmaReport')`
 * reads & writes in app/api/cma/route.ts (list / create), app/api/cma/[id]/route.ts
 * (get / patch / delete), and app/cma/[token]/page.tsx (public share lookup).
 *
 * shareToken generation stays in the route (lib generateShareToken). The
 * CmaReport_shareToken_key UNIQUE(shareToken) invariant is preserved by reading
 * the token before insert inside the create mutation (serializable).
 */

const statusValidator = v.union(v.literal('draft'), v.literal('published'));

type CmaFields = {
  id: string;
  spaceId: string;
  subjectAddress: string;
  subjectProductId?: string;
  shareToken: string;
  title?: string;
  status: 'draft' | 'published';
  payload: unknown;
  createdAt: string;
  updatedAt: string;
};

/** The list-row shape (LIST_COLUMNS): everything except payload. */
function toListRow(r: CmaFields) {
  return {
    id: r.id,
    spaceId: r.spaceId,
    subjectAddress: r.subjectAddress,
    subjectProductId: r.subjectProductId ?? null,
    shareToken: r.shareToken,
    title: r.title ?? null,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The full-row shape (FULL_COLUMNS): list columns + payload. */
function toFullRow(r: CmaFields) {
  return { ...toListRow(r), payload: r.payload ?? {} };
}

/** The public share read (page) selects id, spaceId, subjectAddress, title,
 *  status, payload — a subset of the full row, which toFullRow covers. */

/** A space's reports, newest-first (cap 100). CmaReport_space_created_idx.
 *  Mirrors `.eq('spaceId').order('createdAt', desc).limit(100)` selecting
 *  LIST_COLUMNS. */
export const listForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CmaReport')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .take(100);
    return rows.map(toListRow);
  },
});

/** One report scoped to (id, spaceId) — the full row, or null. Mirrors
 *  `.eq('id').eq('spaceId').maybeSingle()` selecting FULL_COLUMNS. The spaceId
 *  guard is preserved: a mismatched space yields null (cross-space read denied). */
export const getByIdForSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('CmaReport')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.spaceId !== args.spaceId) return null;
    return toFullRow(r);
  },
});

/** One report by public shareToken (CmaReport_shareToken_key UNIQUE), or null —
 *  the /cma/[token] page. Returns the full row (the page reads id, spaceId,
 *  subjectAddress, title, status, payload). */
export const getByShareToken = query({
  args: { shareToken: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('CmaReport')
      .withIndex('by_share_token', (q) => q.eq('shareToken', args.shareToken))
      .unique();
    return r ? toFullRow(r) : null;
  },
});

/**
 * Create a CMA report (POST). Replaces the INSERT. status defaults to 'draft',
 * payload to {} when omitted. The route generated the shareToken and passes it
 * in; we read it first to preserve UNIQUE(shareToken) (a collision is rejected
 * by re-using the existing row's... no — tokens are random; on the astronomically
 * unlikely collision we throw, matching PG's unique-violation). Returns the
 * list-row shape (the route selects LIST_COLUMNS on insert).
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    subjectAddress: v.string(),
    subjectProductId: v.union(v.string(), v.null()),
    shareToken: v.string(),
    title: v.union(v.string(), v.null()),
    status: v.optional(statusValidator),
    payload: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    // Preserve CmaReport_shareToken_key UNIQUE — read-then-insert.
    const clash = await ctx.db
      .query('CmaReport')
      .withIndex('by_share_token', (q) => q.eq('shareToken', args.shareToken))
      .unique();
    if (clash) throw new Error('shareToken collision');

    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      subjectAddress: args.subjectAddress,
      ...(args.subjectProductId !== null ? { subjectProductId: args.subjectProductId } : {}),
      shareToken: args.shareToken,
      ...(args.title !== null ? { title: args.title } : {}),
      status: args.status ?? ('draft' as const),
      payload: args.payload ?? {},
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('CmaReport', doc);
    return toListRow(doc);
  },
});

/**
 * Patch a report scoped to (id, spaceId) (PATCH). Always bumps updatedAt; sets
 * status and/or title only when provided (title null clears the column). Mirrors
 * `.update({ updatedAt, status?, title? }).eq('id').eq('spaceId').select(FULL).maybeSingle()`.
 * Returns the full row, or null when no row matched the (id, spaceId) guard.
 */
export const patchForSpace = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    status: v.optional(statusValidator),
    title: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('CmaReport')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.spaceId !== args.spaceId) return null;
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.title !== undefined) patch.title = args.title === null ? undefined : args.title;
    await ctx.db.patch(r._id, patch);
    return toFullRow((await ctx.db.get(r._id))!);
  },
});

/** Delete a report scoped to (id, spaceId) (DELETE). Mirrors
 *  `.delete().eq('id').eq('spaceId')`. No-op (and the guard denies) on mismatch. */
export const deleteForSpace = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const r = await ctx.db
      .query('CmaReport')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (r && r.spaceId === args.spaceId) await ctx.db.delete(r._id);
  },
});
