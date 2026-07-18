import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * StudioGeneration data access — the Convex replacement for the Supabase
 * reads/writes in lib/studio/generate.ts, lib/studio/edit.ts, lib/studio/spend.ts,
 * app/api/studio/recent-job/route.ts, and app/api/studio/library/route.ts.
 *
 * The fal call, storage upload, and File row stay in lib (cross-domain + I/O);
 * only the StudioGeneration row's lifecycle (insert running -> patch
 * failed/completed) and the read queries move here.
 */

const kindValidator = v.union(v.literal('image'), v.literal('video'));

/**
 * Insert a generation row in 'running' state and return its id. The caller
 * (lib) already minted the id with crypto.randomUUID() so it can reference the
 * row before the model call returns — keep accepting it.
 */
export const insertRunning = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    userId: v.string(),
    kind: kindValidator,
    model: v.string(),
    prompt: v.optional(v.string()),
    sourceFileId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('StudioGeneration', {
      id: args.id,
      spaceId: args.spaceId,
      userId: args.userId,
      kind: args.kind,
      model: args.model,
      prompt: args.prompt,
      sourceFileId: args.sourceFileId,
      status: 'running',
      costUsd: 0,
      createdAt: new Date().toISOString(),
    });
  },
});

/** Mark a generation failed with an error message and a completion timestamp. */
export const markFailed = mutation({
  args: { id: v.string(), errorMessage: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db
      .query('StudioGeneration')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, {
      status: 'failed',
      errorMessage: args.errorMessage,
      completedAt: new Date().toISOString(),
    });
  },
});

/** Mark a generation completed with its resulting File id and metered cost. */
export const markCompleted = mutation({
  args: { id: v.string(), fileId: v.string(), costUsd: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db
      .query('StudioGeneration')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, {
      status: 'completed',
      fileId: args.fileId,
      costUsd: args.costUsd,
      completedAt: new Date().toISOString(),
    });
  },
});

/**
 * Sum costUsd for a space since an ISO timestamp (the daily spend window). The
 * (spaceId, createdAt) index lets the >= range run on the index.
 */
export const spendSince = query({
  args: { spaceId: v.string(), since: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('StudioGeneration')
      .withIndex('by_space_created', (q) =>
        q.eq('spaceId', args.spaceId).gte('createdAt', args.since),
      )
      .collect();
    let total = 0;
    for (const row of rows) {
      if (typeof row.costUsd === 'number' && Number.isFinite(row.costUsd)) {
        total += row.costUsd;
      }
    }
    return total;
  },
});

export interface RecentJobRow {
  id: string;
  status: string;
  kind: 'image' | 'video';
  fileId: string | null;
  errorMessage: string | null;
  sourceFileId: string | null;
  createdAt: string;
}

/**
 * The most recent generation for a space, newest first, optionally filtered by
 * whether it was a fresh prompt (source='create' => no sourceFileId) or an edit
 * (source='edit' => has a sourceFileId). Mirrors the recent-job route's
 * is/not('sourceFileId', null) + order(createdAt desc).limit(1).
 */
export const recentJob = query({
  args: {
    spaceId: v.string(),
    source: v.optional(v.union(v.literal('create'), v.literal('edit'))),
  },
  handler: async (ctx, args): Promise<RecentJobRow | null> => {
    // Walk newest-first on the index; the source filter is sparse so filter
    // in-handler and stop at the first match.
    for await (const row of ctx.db
      .query('StudioGeneration')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')) {
      const hasSource = row.sourceFileId != null;
      if (args.source === 'create' && hasSource) continue;
      if (args.source === 'edit' && !hasSource) continue;
      return {
        id: row.id,
        status: row.status,
        kind: row.kind,
        fileId: row.fileId ?? null,
        errorMessage: row.errorMessage ?? null,
        sourceFileId: row.sourceFileId ?? null,
        createdAt: row.createdAt,
      };
    }
    return null;
  },
});

export interface LibraryRow {
  id: string;
  kind: string;
  model: string;
  prompt: string | null;
  fileId: string;
  createdAt: string;
}

/**
 * A page of completed generations with a non-null fileId for a space, newest
 * first. Mirrors the library route's eq(status,'completed').not(fileId,null)
 * .order(createdAt desc).range(offset, offset+pageSize-1).
 */
export const library = query({
  args: { spaceId: v.string(), offset: v.number(), pageSize: v.number() },
  handler: async (ctx, args): Promise<LibraryRow[]> => {
    const end = args.offset + args.pageSize;
    const out: LibraryRow[] = [];
    let seen = 0;
    for await (const row of ctx.db
      .query('StudioGeneration')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')) {
      if (row.status !== 'completed' || row.fileId == null) continue;
      if (seen >= args.offset && seen < end) {
        out.push({
          id: row.id,
          kind: row.kind,
          model: row.model,
          prompt: row.prompt ?? null,
          fileId: row.fileId,
          createdAt: row.createdAt,
        });
      }
      seen += 1;
      if (seen >= end) break;
    }
    return out;
  },
});
