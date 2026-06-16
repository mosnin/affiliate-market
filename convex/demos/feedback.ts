import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * DemoFeedback data access — Convex replacement for the Supabase reads/writes
 * in app/api/demos/feedback/route.ts.
 *
 * Invariant carried from Postgres: one feedback row per demo. PG had no UNIQUE
 * on demoId, but the POST handler enforces it with an existence check; that
 * read-then-insert collapses into the single serializable `create` mutation.
 *
 * The PG row's id and createdAt had column defaults the app omitted on insert;
 * here we generate both (crypto.randomUUID + ISO now), matching the values
 * Postgres would have filled in.
 */

type FeedbackFields = {
  id: string;
  demoId: string;
  spaceId: string;
  rating: number;
  comment?: string;
  createdAt: string;
};

/** Legacy row shape: drop _id, surface `id`, coerce absent comment -> null. */
function toRow(f: FeedbackFields) {
  return {
    id: f.id,
    demoId: f.demoId,
    spaceId: f.spaceId,
    rating: f.rating,
    comment: f.comment ?? null,
    createdAt: f.createdAt,
  };
}

/**
 * Feedback for a single demo (scoped to a space when the agent GET passes one),
 * or null. Replaces the POST existence check `.eq('demoId').maybeSingle()` and
 * the agent GET `.eq('demoId').eq('spaceId').maybeSingle()`. One row per demo.
 */
export const getByDemo = query({
  args: { demoId: v.string(), spaceId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('DemoFeedback')
      .withIndex('by_demo', (q) => q.eq('demoId', args.demoId))
      .unique();
    if (!doc) return null;
    if (args.spaceId !== undefined && doc.spaceId !== args.spaceId) return null;
    return toRow(doc);
  },
});

/**
 * All feedback for a space, newest-first (cap 100). Replaces the agent GET's
 * `.eq('spaceId').order('createdAt', desc).limit(100)`.
 */
export const listBySpace = query({
  args: { spaceId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DemoFeedback')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .take(args.limit ?? 100);
    return rows.map(toRow);
  },
});

/**
 * Create feedback for a demo, enforcing one-per-demo. Returns the inserted row,
 * or null if feedback already exists (the route maps null -> 409). Replaces the
 * existence-check-then-insert. `comment` null clears the column.
 */
export const create = mutation({
  args: {
    demoId: v.string(),
    spaceId: v.string(),
    rating: v.number(),
    comment: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('DemoFeedback')
      .withIndex('by_demo', (q) => q.eq('demoId', args.demoId))
      .unique();
    if (existing) return null; // caller returns 409 (already submitted)

    const doc = {
      id: crypto.randomUUID(),
      demoId: args.demoId,
      spaceId: args.spaceId,
      rating: args.rating,
      ...(args.comment !== null ? { comment: args.comment } : {}),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('DemoFeedback', doc);
    return toRow(doc);
  },
});
