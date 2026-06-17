import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * Note data access — Convex replacement for `.from('Note')` reads/writes (notes
 * GET/POST/PATCH/DELETE, mcp list_notes/get_note, voice & realtime context,
 * account export, the manager member-dashboard '[ANN]%' announcement scan).
 *
 * Note here is the space's free-form notes pad (NOT a deal note — those are
 * DealActivity rows). It lives in the deals domain per the table ownership split.
 */

type NoteFields = {
  id: string;
  spaceId: string;
  title: string;
  content: string;
  icon?: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

function toRow(n: NoteFields) {
  return {
    id: n.id,
    spaceId: n.spaceId,
    title: n.title,
    content: n.content,
    icon: n.icon ?? null,
    sortOrder: n.sortOrder,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** One note by id scoped to a space, or null (notes GET-by-id, mcp get_note).
 *  Mirrors `.eq('id').eq('spaceId').maybeSingle()`. */
export const getByIdInSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const n = await ctx.db
      .query('Note')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!n || n.spaceId !== args.spaceId) return null;
    return toRow(n);
  },
});

/**
 * A space's notes ordered by sortOrder (notes GET, account export). The list GET
 * selected `id, title, icon, sortOrder, updatedAt`; callers that need fewer
 * columns just read those off the row. Rides by_space_sort.
 */
export const listBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Note')
      .withIndex('by_space_sort', (q) => q.eq('spaceId', args.spaceId))
      .order('asc')
      .collect();
    return rows.map(toRow);
  },
});

/**
 * A space's notes ordered by updatedAt desc, capped (mcp list_notes + voice/
 * realtime context). Replaces `.eq('spaceId').order('updatedAt', desc).limit(n)`.
 * No updatedAt index — rides by_space_sort then sorts in-handler (note counts per
 * space are small).
 */
export const listBySpaceRecent = query({
  args: { spaceId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Note')
      .withIndex('by_space_sort', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    const capped = args.limit !== undefined ? rows.slice(0, args.limit) : rows;
    return capped.map(toRow);
  },
});

/**
 * Announcement notes across several spaces — title starting with a prefix
 * (member-dashboard '[ANN]%'), newest-first, capped. Replaces
 * `.ilike('title', '[ANN]%').in('spaceId', spaceIds).order('createdAt', desc).
 * limit(n)`. Fans out per space; matches the prefix case-insensitively.
 */
export const listByTitlePrefix = query({
  args: { spaceIds: v.array(v.string()), prefix: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const needle = args.prefix.toLowerCase();
    const all: NoteFields[] = [];
    for (const spaceId of args.spaceIds) {
      const rows = await ctx.db
        .query('Note')
        .withIndex('by_space_sort', (q) => q.eq('spaceId', spaceId))
        .collect();
      for (const n of rows) if (n.title.toLowerCase().startsWith(needle)) all.push(n);
    }
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const capped = args.limit !== undefined ? all.slice(0, args.limit) : all;
    return capped.map(toRow);
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────

/** Next sortOrder at the end of a space's note list (notes POST). Replaces
 *  `.eq('spaceId').order('sortOrder', desc).limit(1)`. */
export const nextSortOrder = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Note')
      .withIndex('by_space_sort', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const max = rows.reduce((m, n) => (n.sortOrder > m ? n.sortOrder : m), -1);
    return max + 1;
  },
});

/** Insert a note. title defaults to PG 'Untitled', content to ''. The caller
 *  resolves sortOrder first. Returns the inserted row. */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    spaceId: v.string(),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    icon: v.optional(v.union(v.string(), v.null())),
    sortOrder: v.number(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      spaceId: args.spaceId,
      title: args.title ?? 'Untitled',
      content: args.content ?? '',
      ...(args.icon != null ? { icon: args.icon } : {}),
      sortOrder: args.sortOrder,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('Note', doc);
    return toRow(doc);
  },
});

/** Patch a note (title/content/icon/sortOrder), scoped to spaceId, bumping
 *  updatedAt. Tri-state icon: value to set, null to clear, omit to leave. Returns
 *  updated row or null on mismatch. */
export const updateById = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    icon: v.optional(v.union(v.string(), v.null())),
    sortOrder: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const n = await ctx.db
      .query('Note')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!n || n.spaceId !== args.spaceId) return null;
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.title !== undefined) patch.title = args.title;
    if (args.content !== undefined) patch.content = args.content;
    if (args.icon !== undefined) patch.icon = args.icon ?? undefined;
    if (args.sortOrder !== undefined) patch.sortOrder = args.sortOrder;
    await ctx.db.patch(n._id, patch);
    const updated = (await ctx.db.get(n._id))!;
    return toRow(updated);
  },
});

/** Delete a note by id, scoped to spaceId. Returns true iff deleted. */
export const deleteById = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const n = await ctx.db
      .query('Note')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!n || n.spaceId !== args.spaceId) return false;
    await ctx.db.delete(n._id);
    return true;
  },
});
