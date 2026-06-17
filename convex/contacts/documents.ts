import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ContactDocument data access — buyer-uploaded application files (IDs, bank
 * statements, signed applications). Convex replacement for every
 * `.from('ContactDocument')` op: the documents list (GET /api/documents), the
 * upload insert (POST /api/documents), the single-doc fetch + delete
 * (/api/documents/[id]), the pre-delete storageKey grab in the contact &
 * manager-lead delete routes, and the storage-gc cron's "is this key still
 * referenced?" probe.
 *
 * No money. No uniqueness invariant. Contact-delete CASCADE to these rows lives in
 * contacts.deleteContact (this domain), so there's no cascade here.
 *
 * NOTE: Wasabi objects do NOT cascade — every flow that removes a ContactDocument
 * row still drops the object via lib/storage afterward, using the storageKey these
 * functions return. The DB hop is all that moves to Convex.
 */

type DocumentFields = {
  id: string;
  contactId: string;
  spaceId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  storageKey: string;
  uploadedBy: string;
  createdAt: string;
};

/** Full ContactDocument row (all columns NOT NULL in PG, so no null-coercion). */
function toRow(d: DocumentFields) {
  return {
    id: d.id,
    contactId: d.contactId,
    spaceId: d.spaceId,
    fileName: d.fileName,
    fileType: d.fileType,
    fileSize: d.fileSize,
    storageKey: d.storageKey,
    uploadedBy: d.uploadedBy,
    createdAt: d.createdAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A contact's documents, newest-first. GET /api/documents
 *  (`.eq('contactId').order(createdAt desc)`). */
export const listForContact = query({
  args: { contactId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ContactDocument')
      .withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
      .collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.map(toRow);
  },
});

/** One document by id, or null. GET/DELETE /api/documents/[id] resolve the row
 *  (then check scope) by id (`.eq('id').maybeSingle()`). */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('ContactDocument')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return d ? toRow(d) : null;
  },
});

/** Just the storageKeys for a contact's documents — the pre-delete grab in the
 *  contact / manager-lead DELETE routes (`.select('storageKey').eq('contactId')`).
 *  (contacts.deleteContact returns these too on cascade; this serves callers that
 *  read keys WITHOUT deleting the contact.) */
export const storageKeysForContact = query({
  args: { contactId: v.string(), spaceId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<string[]> => {
    let rows = await ctx.db
      .query('ContactDocument')
      .withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
      .collect();
    if (args.spaceId !== undefined) rows = rows.filter((d) => d.spaceId === args.spaceId);
    return rows.map((d) => d.storageKey).filter((k): k is string => Boolean(k));
  },
});

/** Which of `candidates` are still referenced by a ContactDocument (storage-gc).
 *  Mirrors `.select('storageKey').in('storageKey', candidates)` — returns the
 *  subset that EXISTS so the GC keeps those objects and sweeps the rest. */
export const referencedStorageKeys = query({
  args: { candidates: v.array(v.string()) },
  handler: async (ctx, args): Promise<string[]> => {
    const found: string[] = [];
    for (const key of args.candidates) {
      const hit = await ctx.db
        .query('ContactDocument')
        .withIndex('by_storage_key', (q) => q.eq('storageKey', key))
        .first();
      if (hit) found.push(key);
    }
    return found;
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/** Insert an uploaded document. POST /api/documents. uploadedBy defaults 'guest'
 *  (PG default). Returns the row. */
export const create = mutation({
  args: {
    contactId: v.string(),
    spaceId: v.string(),
    fileName: v.string(),
    fileType: v.string(),
    fileSize: v.number(),
    storageKey: v.string(),
    uploadedBy: v.optional(v.string()),
    id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      contactId: args.contactId,
      spaceId: args.spaceId,
      fileName: args.fileName,
      fileType: args.fileType,
      fileSize: args.fileSize,
      storageKey: args.storageKey,
      uploadedBy: args.uploadedBy ?? 'guest',
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('ContactDocument', doc);
    return toRow(doc);
  },
});

/**
 * Delete a document by id, CAS-scoped to its space (DELETE /api/documents/[id]
 * does `.eq('id').eq('spaceId', doc.spaceId)`). Returns the deleted row's
 * storageKey so the caller can drop the Wasabi object (no cascade), or null if not
 * found / scope mismatch.
 */
export const remove = mutation({
  args: { id: v.string(), spaceId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ storageKey: string } | null> => {
    const d = await ctx.db
      .query('ContactDocument')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d) return null;
    if (args.spaceId !== undefined && d.spaceId !== args.spaceId) return null;
    const storageKey = d.storageKey;
    await ctx.db.delete(d._id);
    return { storageKey };
  },
});
