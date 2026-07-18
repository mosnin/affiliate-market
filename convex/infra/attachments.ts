import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * Attachment data access — the Convex replacement for `.from('Attachment')` in
 * GET /api/files (chat-upload union), POST/DELETE /api/ai/attachments, the
 * read_attachment tool, the /api/ai/task hydrate batch, and the account-deletion
 * sweep. Storage upload/sign/delete stays in the routes.
 */

const extractionStatusValidator = v.union(
  v.literal('pending'),
  v.literal('skipped'),
  v.literal('done'),
  v.literal('failed'),
);

type AttachmentFields = {
  id: string;
  spaceId: string;
  userId?: string;
  conversationId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  publicUrl: string;
  extractedText?: string;
  extractionStatus: 'pending' | 'skipped' | 'done' | 'failed';
  createdAt: string;
};

/** Full Attachment row, optionals coerced to SQL NULL. */
function toAttachmentRow(a: AttachmentFields) {
  return {
    id: a.id,
    spaceId: a.spaceId,
    userId: a.userId ?? null,
    conversationId: a.conversationId ?? null,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    storagePath: a.storagePath,
    publicUrl: a.publicUrl,
    extractedText: a.extractedText ?? null,
    extractionStatus: a.extractionStatus,
    createdAt: a.createdAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** read_attachment: one attachment by id+space, or null. Mirrors
 *  `.from('Attachment').select('id, filename, mimeType, sizeBytes,
 *  extractionStatus, extractedText').eq('id').eq('spaceId').maybeSingle()`. */
export const getByIdForSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const a = await ctx.db
      .query('Attachment')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!a || a.spaceId !== args.spaceId) return null;
    return toAttachmentRow(a);
  },
});

/** DELETE /api/ai/attachments lookup: one attachment by id (NO space scope in
 *  the query — the route compares spaceId in mem to return 403 vs 404). Mirrors
 *  `.select('id, spaceId, storagePath').eq('id').maybeSingle()`. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const a = await ctx.db
      .query('Attachment')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return a ? toAttachmentRow(a) : null;
  },
});

/** A space's chat attachments newest-first (cap 500) — the GET /api/files union
 *  half. Mirrors `.select('id, filename, mimeType, sizeBytes, storagePath,
 *  createdAt').eq('spaceId').order(createdAt desc).limit(500)`. */
export const listForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Attachment')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .take(500);
    return rows.map(toAttachmentRow);
  },
});

/** /api/ai/task hydrate: attachments matching a set of ids, scoped to a space.
 *  Mirrors `.select('id, filename, mimeType, extractedText, storagePath,
 *  extractionStatus').in('id', ids).eq('spaceId', spaceId)`. */
export const listByIdsForSpace = query({
  args: { ids: v.array(v.string()), spaceId: v.string() },
  handler: async (ctx, args) => {
    const out: ReturnType<typeof toAttachmentRow>[] = [];
    for (const id of args.ids) {
      const a = await ctx.db
        .query('Attachment')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (a && a.spaceId === args.spaceId) out.push(toAttachmentRow(a));
    }
    return out;
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/** Insert a chat-attachment row. POST /api/ai/attachments mints the id + uploads
 *  the object first; publicUrl is stored as '' (readers re-sign from
 *  storagePath). extractionStatus is 'skipped' for images, 'pending' otherwise
 *  (decided by the route). userId/conversationId are nullable. */
export const create = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    userId: v.union(v.string(), v.null()),
    conversationId: v.union(v.string(), v.null()),
    filename: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    storagePath: v.string(),
    publicUrl: v.string(),
    extractionStatus: extractionStatusValidator,
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('Attachment', {
      id: args.id,
      spaceId: args.spaceId,
      ...(args.userId !== null ? { userId: args.userId } : {}),
      ...(args.conversationId !== null ? { conversationId: args.conversationId } : {}),
      filename: args.filename,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      storagePath: args.storagePath,
      publicUrl: args.publicUrl,
      extractionStatus: args.extractionStatus,
      createdAt: new Date().toISOString(),
    });
  },
});

/** Delete one attachment by id. Mirrors DELETE /api/ai/attachments'
 *  `.from('Attachment').delete().eq('id', id)` (the route already verified
 *  ownership via getById, and deleted the storage object first). */
export const deleteById = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const a = await ctx.db
      .query('Attachment')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (a) await ctx.db.delete(a._id);
  },
});

/** Account-deletion sweep: hard-delete every attachment for a space. Mirrors
 *  `.from('Attachment').delete().eq('spaceId', spaceId)`. Returns the count so
 *  the caller can log/verify. */
export const deleteForSpace = mutation({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Attachment')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    for (const a of rows) await ctx.db.delete(a._id);
    return rows.length;
  },
});
