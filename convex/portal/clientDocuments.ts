import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ClientDocument data access — the Convex replacement for the `.from('ClientDocument')`
 * ops in app/api/contacts/[id]/client-documents/route.ts and
 * app/api/clients/documents/route.ts (the seller- and client-side views of a
 * contact's uploaded files).
 *
 * Storage upload/download (uploadObject / signed URLs / fileKey generation) stays
 * in the routes. This layer persists the metadata row and lists it.
 */

/** The list-row shape both routes select: id, fileName, contentType, sizeBytes,
 *  uploadedBy, createdAt. Absent optionals -> SQL NULL. */
function toListRow(d: {
  id: string;
  fileName: string;
  contentType?: string;
  sizeBytes?: number;
  uploadedBy: string;
  createdAt: string;
}) {
  return {
    id: d.id,
    fileName: d.fileName,
    contentType: d.contentType ?? null,
    sizeBytes: d.sizeBytes ?? null,
    uploadedBy: d.uploadedBy,
    createdAt: d.createdAt,
  };
}

/**
 * A contact's documents, newest-first. ClientDocument_contact_idx. Mirrors the
 * list GET `.select('id, fileName, contentType, sizeBytes, uploadedBy, createdAt')
 * .eq('contactId').order('createdAt', desc)`.
 */
export const listForContact = query({
  args: { contactId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ClientDocument')
      .withIndex('by_contact_created', (q) => q.eq('contactId', args.contactId))
      .order('desc')
      .collect();
    return rows.map(toListRow);
  },
});

/**
 * The fileKey for one document scoped to (id, contactId) — the download fetch.
 * Mirrors `.select('fileKey').eq('id').eq('contactId').maybeSingle()`. Returns
 * the fileKey string or null (the contactId guard denies cross-contact reads).
 */
export const fileKeyForDownload = query({
  args: { id: v.string(), contactId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const d = await ctx.db
      .query('ClientDocument')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d || d.contactId !== args.contactId) return null;
    return d.fileKey;
  },
});

/**
 * Insert a document metadata row after a successful upload (client-side POST).
 * Replaces `.insert({ contactId, spaceId, fileKey, fileName, contentType,
 * sizeBytes, uploadedBy:'client' }).select(LIST).single()`. uploadedBy defaults
 * to 'client'. contentType/sizeBytes null = unset. Returns the list-row.
 */
export const create = mutation({
  args: {
    contactId: v.string(),
    spaceId: v.string(),
    fileKey: v.string(),
    fileName: v.string(),
    contentType: v.union(v.string(), v.null()),
    sizeBytes: v.union(v.number(), v.null()),
    uploadedBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: crypto.randomUUID(),
      contactId: args.contactId,
      spaceId: args.spaceId,
      fileKey: args.fileKey,
      fileName: args.fileName,
      ...(args.contentType !== null ? { contentType: args.contentType } : {}),
      ...(args.sizeBytes !== null ? { sizeBytes: args.sizeBytes } : {}),
      uploadedBy: args.uploadedBy ?? 'client',
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('ClientDocument', doc);
    return toListRow(doc);
  },
});
