import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * Announcement data access — Convex replacement for the Supabase reads/writes in
 * app/api/platform/announcements/route.ts (segmented GET),
 * app/api/admin/announcements/route.ts (admin list/create/delete),
 * app/api/admin/announcements/[id]/route.ts (patch/delete), and
 * app/admin/announcements/page.tsx (server-component list).
 *
 * Returns the full legacy row shape (the `Announcement` type the admin client +
 * platform banner consume): nullable columns surface as `null`.
 */

const severityValidator = v.union(
  v.literal('info'),
  v.literal('warning'),
  v.literal('critical'),
);
const segmentValidator = v.union(
  v.literal('all'),
  v.literal('trial'),
  v.literal('active'),
  v.literal('past_due'),
  v.literal('admin'),
);

/** Full Announcement row (drop _id/_creationTime, surface `id`, coerce absent
 *  optionals to the SQL NULLs the client type declares). */
function toRow(doc: Doc<'Announcement'>) {
  return {
    id: doc.id,
    message: doc.message,
    title: doc.title ?? null,
    severity: doc.severity,
    targetSegment: doc.targetSegment,
    linkUrl: doc.linkUrl ?? null,
    linkLabel: doc.linkLabel ?? null,
    dismissible: doc.dismissible,
    active: doc.active,
    startsAt: doc.startsAt ?? null,
    endsAt: doc.endsAt ?? null,
    createdBy: doc.createdBy ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Active announcements targeting any of the given segments and live at `now`,
 * newest first. Replaces the platform GET read:
 *   .eq('active', true).in('targetSegment', segments)
 *   .or('startsAt.is.null,startsAt.lte.now').or('endsAt.is.null,endsAt.gte.now')
 *   .order('createdAt', desc)
 * The segment-IN and nullable time-window predicates have no single index, so we
 * scan active=true on `by_active` and apply them in the handler.
 */
export const listActiveForSegments = query({
  args: { segments: v.array(v.string()), now: v.string() },
  handler: async (ctx, args) => {
    const segmentSet = new Set(args.segments);
    const rows = await ctx.db
      .query('Announcement')
      .withIndex('by_active', (q) => q.eq('active', true))
      .collect();
    const live = rows.filter(
      (r) =>
        segmentSet.has(r.targetSegment) &&
        // startsAt null OR startsAt <= now
        (r.startsAt == null || r.startsAt <= args.now) &&
        // endsAt null OR endsAt >= now
        (r.endsAt == null || r.endsAt >= args.now),
    );
    // newest first (was .order('createdAt', { ascending: false }))
    live.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return live.map(toRow);
  },
});

/**
 * All announcements, newest first (admin list, limit 100). Replaces
 * `.select('*').order('createdAt', desc).limit(100)` in both the admin GET route
 * and the admin server-component page. No index needed beyond a full scan +
 * sort; the table is small (platform-wide announcements).
 */
export const listAll = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query('Announcement').collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.slice(0, args.limit ?? 100).map(toRow);
  },
});

/**
 * One announcement by id, or null. Replaces the dismiss route's
 * `.select('id, dismissible').eq('id', id).maybeSingle()` (callers read only the
 * fields they need off the full row).
 */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('Announcement')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return doc ? toRow(doc) : null;
  },
});

/**
 * Create an announcement. Returns the persisted row (the admin POST route
 * `.insert(...).select().maybeSingle()`). Optional columns are omitted when null
 * so they read back as SQL NULL.
 */
export const create = mutation({
  args: {
    message: v.string(),
    title: v.union(v.string(), v.null()),
    severity: severityValidator,
    targetSegment: segmentValidator,
    linkUrl: v.union(v.string(), v.null()),
    linkLabel: v.union(v.string(), v.null()),
    dismissible: v.boolean(),
    active: v.boolean(),
    startsAt: v.union(v.string(), v.null()),
    endsAt: v.union(v.string(), v.null()),
    createdBy: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      message: args.message,
      ...(args.title !== null ? { title: args.title } : {}),
      severity: args.severity,
      targetSegment: args.targetSegment,
      ...(args.linkUrl !== null ? { linkUrl: args.linkUrl } : {}),
      ...(args.linkLabel !== null ? { linkLabel: args.linkLabel } : {}),
      dismissible: args.dismissible,
      active: args.active,
      ...(args.startsAt !== null ? { startsAt: args.startsAt } : {}),
      ...(args.endsAt !== null ? { endsAt: args.endsAt } : {}),
      ...(args.createdBy !== null ? { createdBy: args.createdBy } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const _id = await ctx.db.insert('Announcement', doc);
    const inserted = await ctx.db.get(_id);
    return inserted ? toRow(inserted) : null;
  },
});

/**
 * Patch an announcement's mutable fields + bump updatedAt. Returns the updated
 * row, or null if the id doesn't exist (the admin PATCH route maps null -> 404).
 *
 * Only keys present in `patch` are written. A key set to null clears the column
 * (the old partial update wrote null for title/linkUrl/linkLabel when cleared),
 * so nullable fields are patched to `undefined` to remove them from the doc.
 */
export const update = mutation({
  args: {
    id: v.string(),
    patch: v.object({
      message: v.optional(v.string()),
      title: v.optional(v.union(v.string(), v.null())),
      severity: v.optional(severityValidator),
      targetSegment: v.optional(segmentValidator),
      linkUrl: v.optional(v.union(v.string(), v.null())),
      linkLabel: v.optional(v.union(v.string(), v.null())),
      dismissible: v.optional(v.boolean()),
      active: v.optional(v.boolean()),
      startsAt: v.optional(v.union(v.string(), v.null())),
      endsAt: v.optional(v.union(v.string(), v.null())),
    }),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('Announcement')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!existing) return null;

    const p = args.patch;
    const writes: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    // Required (non-nullable) fields: write through when supplied.
    if (p.message !== undefined) writes.message = p.message;
    if (p.severity !== undefined) writes.severity = p.severity;
    if (p.targetSegment !== undefined) writes.targetSegment = p.targetSegment;
    if (p.dismissible !== undefined) writes.dismissible = p.dismissible;
    if (p.active !== undefined) writes.active = p.active;
    // Nullable fields: null clears the column (patch undefined removes it).
    if (p.title !== undefined) writes.title = p.title === null ? undefined : p.title;
    if (p.linkUrl !== undefined) writes.linkUrl = p.linkUrl === null ? undefined : p.linkUrl;
    if (p.linkLabel !== undefined) writes.linkLabel = p.linkLabel === null ? undefined : p.linkLabel;
    if (p.startsAt !== undefined) writes.startsAt = p.startsAt === null ? undefined : p.startsAt;
    if (p.endsAt !== undefined) writes.endsAt = p.endsAt === null ? undefined : p.endsAt;

    await ctx.db.patch(existing._id, writes);
    const updated = await ctx.db.get(existing._id);
    return updated ? toRow(updated) : null;
  },
});

/**
 * Delete an announcement by id. Replaces `.delete().eq('id', id)` in the admin
 * DELETE routes. No-op if it's already gone.
 *
 * PG cascaded the delete to AnnouncementDismissal (FK ON DELETE CASCADE); that
 * isn't re-created cross-table here (orphaned dismissals are harmless — the GET
 * only joins from live announcements). If strict cleanup is wanted later, also
 * delete dismissals via api.notifications.dismissals at the lib boundary.
 */
export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query('Announcement')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
