import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * StudioPost data access — the Convex replacement for the Supabase reads/writes
 * in app/api/studio/schedule/route.ts and the StudioPost touches in
 * lib/inngest/functions.ts (publishScheduledPost). The File-storageKey lookup,
 * Inngest send, and Composio publish stay in lib (other domains + I/O); only the
 * StudioPost row's lifecycle moves here.
 */

const statusValidator = v.union(
  v.literal('scheduled'),
  v.literal('publishing'),
  v.literal('posted'),
  v.literal('failed'),
  v.literal('canceled'),
);

/** The public row shape the schedule route returns to the client. */
export interface PostSummary {
  id: string;
  caption: string;
  platforms: string[];
  scheduledAt: string;
  status: string;
  createdAt: string;
}

/** A space's scheduled posts, soonest first (matches order(scheduledAt asc).limit(100)). */
export const listForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<PostSummary[]> => {
    const rows = await ctx.db
      .query('StudioPost')
      .withIndex('by_space_scheduled', (q) => q.eq('spaceId', args.spaceId))
      .order('asc')
      .take(100);
    return rows.map((r) => ({
      id: r.id,
      caption: r.caption,
      platforms: r.platforms,
      scheduledAt: r.scheduledAt,
      status: r.status,
      createdAt: r.createdAt,
    }));
  },
});

/** Queue a post in 'scheduled' state and return its summary row. */
export const insertPost = mutation({
  args: {
    spaceId: v.string(),
    userId: v.string(),
    fileId: v.string(),
    caption: v.string(),
    platforms: v.array(v.string()),
    scheduledAt: v.string(),
  },
  handler: async (ctx, args): Promise<PostSummary> => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await ctx.db.insert('StudioPost', {
      id,
      spaceId: args.spaceId,
      userId: args.userId,
      fileId: args.fileId,
      caption: args.caption,
      platforms: args.platforms,
      scheduledAt: args.scheduledAt,
      status: 'scheduled',
      platformResults: {},
      createdAt: now,
      updatedAt: now,
    });
    return {
      id,
      caption: args.caption,
      platforms: args.platforms,
      scheduledAt: args.scheduledAt,
      status: 'scheduled',
      createdAt: now,
    };
  },
});

/** Stamp the Inngest event id on a freshly-scheduled post. */
export const setInngestEventId = mutation({
  args: { id: v.string(), inngestEventId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db
      .query('StudioPost')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, { inngestEventId: args.inngestEventId });
  },
});

/** Flip a post to 'failed' (used when the Inngest send fails after insert). */
export const markFailed = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db
      .query('StudioPost')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, { status: 'failed', updatedAt: new Date().toISOString() });
  },
});

/**
 * Cancel a still-scheduled post in a given space. CAS on status='scheduled':
 * returns true only if it was canceled, mirroring the .eq(status,'scheduled')
 * guard the old update used to make this the whole cancel mechanism.
 */
export const cancel = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query('StudioPost')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!row || row.spaceId !== args.spaceId || row.status !== 'scheduled') return false;
    await ctx.db.patch(row._id, { status: 'canceled', updatedAt: new Date().toISOString() });
    return true;
  },
});

// ── Inngest publishScheduledPost touches ──────────────────────────────────

/** The post's owner userId (used to resolve spaceId for the dead-letter write). */
export const getUserId = query({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await ctx.db
      .query('StudioPost')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return row?.userId ?? null;
  },
});

export interface PostForPublish {
  status: string;
  userId: string;
  caption: string;
  platforms: string[];
  fileId: string;
}

/**
 * The fields publishScheduledPost needs to publish a post. The image's
 * storageKey is resolved separately from the File table (other domain) in lib.
 */
export const getForPublish = query({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<PostForPublish | null> => {
    const row = await ctx.db
      .query('StudioPost')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!row) return null;
    return {
      status: row.status,
      userId: row.userId,
      caption: row.caption ?? '',
      platforms: row.platforms ?? [],
      fileId: row.fileId,
    };
  },
});

/** Mark a post failed because its image File is missing. */
export const markMissingImage = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db
      .query('StudioPost')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, {
      status: 'failed',
      platformResults: { error: 'The post image is missing.' },
      updatedAt: new Date().toISOString(),
    });
  },
});

/**
 * Compare-and-swap claim: 'scheduled' -> 'publishing'. Returns true only for the
 * worker that wins the claim, so an at-least-once duplicate delivery can't
 * double-publish. The single-mutation read+patch is serializable in Convex,
 * which is exactly the atomicity the old conditional UPDATE provided.
 */
export const claimForPublish = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query('StudioPost')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!row || row.status !== 'scheduled') return false;
    await ctx.db.patch(row._id, { status: 'publishing', updatedAt: new Date().toISOString() });
    return true;
  },
});

/** Record the publish outcome: posted (if any platform succeeded) or failed. */
export const finalize = mutation({
  args: {
    id: v.string(),
    posted: v.boolean(),
    platformResults: v.any(),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db
      .query('StudioPost')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!row) return;
    const now = new Date().toISOString();
    await ctx.db.patch(row._id, {
      status: args.posted ? 'posted' : 'failed',
      platformResults: args.platformResults,
      postedAt: args.posted ? now : undefined,
      updatedAt: now,
    });
  },
});
