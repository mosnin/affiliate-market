import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * File data access — the Convex replacement for every `.from('File')` read/
 * write across the Files page, /api/files[/id], /api/files/documents[/id], the
 * studio generate/edit writers, the storage-gc cron, and the AI tools
 * (list_files, read_file, attach_file_to_product, send_email/send_sms file
 * batch loads).
 *
 * In-app "documents" are File rows with mimeType='text/markdown'; the document
 * routes scope every op to (id|space, mimeType=DOC_MIME), mirrored here by the
 * `*Doc` functions. Non-DB orchestration (storage upload/sign/delete, quota
 * math, validation) stays in the routes/lib.
 *
 * UNIQUE(storageKey) is preserved: `create` reads by_storage_key before insert
 * so a colliding key can't be written (the old DB unique index, now race-safe
 * inside one serializable mutation).
 */

const DOC_MIME = 'text/markdown';

type FileFields = {
  id: string;
  spaceId: string;
  userId: string;
  storageKey: string;
  name: string;
  mimeType: string;
  category: string;
  sizeBytes: number;
  isPublic: boolean;
  createdAt: string;
};

/** Full File row in the shape every caller reads. Both a stored Doc and a fresh
 *  insert payload satisfy FileFields, so no cast is needed. */
function toFileRow(f: FileFields) {
  return {
    id: f.id,
    spaceId: f.spaceId,
    userId: f.userId,
    storageKey: f.storageKey,
    name: f.name,
    mimeType: f.mimeType,
    category: f.category,
    sizeBytes: f.sizeBytes,
    isPublic: f.isPublic,
    createdAt: f.createdAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One file by id, scoped to a space, or null. Mirrors
 *  `.from('File').eq('id').eq('spaceId').maybeSingle()` — read_file, studio
 *  recent-job, attach_file_to_product, files/[id] GET+DELETE all use this. */
export const getByIdForSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const f = await ctx.db
      .query('File')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!f || f.spaceId !== args.spaceId) return null;
    return toFileRow(f);
  },
});

/** One document (File with mimeType='text/markdown') by id+space, or null.
 *  Mirrors loadDoc: `.eq('id').eq('spaceId').eq('mimeType', DOC_MIME)`. */
export const getDocByIdForSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const f = await ctx.db
      .query('File')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!f || f.spaceId !== args.spaceId || f.mimeType !== DOC_MIME) return null;
    return toFileRow(f);
  },
});

/** A space's files newest-first (cap 500), optional category filter. Mirrors
 *  GET /api/files' File query (`.eq('spaceId')[.eq('category')].order(createdAt
 *  desc).limit(500)`). Returns full rows; the route signs preview URLs. */
export const listForSpace = query({
  args: { spaceId: v.string(), category: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let rows: Doc<'File'>[];
    if (args.category !== undefined) {
      rows = await ctx.db
        .query('File')
        .withIndex('by_space_category_created', (q) =>
          q.eq('spaceId', args.spaceId).eq('category', args.category!),
        )
        .order('desc')
        .take(500);
    } else {
      rows = await ctx.db
        .query('File')
        .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
        .order('desc')
        .take(500);
    }
    return rows.map(toFileRow);
  },
});

/** list_files tool: a space's files newest-first, optional category + optional
 *  case-insensitive filename substring, capped (default 20). Mirrors
 *  `.eq('spaceId')[.eq('category')][.ilike('name','%q%')].order(createdAt
 *  desc).limit(n)`. The ilike runs in mem (Convex has no ilike). */
export const listForSpaceFiltered = query({
  args: {
    spaceId: v.string(),
    category: v.optional(v.string()),
    query: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const base =
      args.category !== undefined
        ? ctx.db
            .query('File')
            .withIndex('by_space_category_created', (q) =>
              q.eq('spaceId', args.spaceId).eq('category', args.category!),
            )
        : ctx.db
            .query('File')
            .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId));
    let rows = await base.order('desc').collect();
    if (args.query) {
      const needle = args.query.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(needle));
    }
    return rows.slice(0, limit).map(toFileRow);
  },
});

/** A space's documents (mimeType='text/markdown') newest-first (cap 500).
 *  Mirrors GET /api/files/documents (`.eq('spaceId').eq('mimeType',DOC_MIME)
 *  .order(createdAt desc).limit(500)`). */
export const listDocsForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('File')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .collect();
    return rows.filter((r) => r.mimeType === DOC_MIME).slice(0, 500).map(toFileRow);
  },
});

/** Every File row's sizeBytes for a space (POST /api/files quota scan:
 *  `.select('sizeBytes').eq('spaceId')`). Returns the bytes so the route sums
 *  them exactly as before. */
export const sizeBytesForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<number[]> => {
    const rows = await ctx.db
      .query('File')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.map((r) => r.sizeBytes);
  },
});

/** files page status sentence: (count, [sizeBytes…]) for a space. Mirrors the
 *  two queries on app/s/[slug]/files/page.tsx (exact count + sizeBytes scan
 *  cap 500). One call returns both so the page renders without two hops. */
export const spaceFileStats = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<{ count: number; sizeBytes: number[] }> => {
    const rows = await ctx.db
      .query('File')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .collect();
    return { count: rows.length, sizeBytes: rows.slice(0, 500).map((r) => r.sizeBytes) };
  },
});

/** Files matching a set of ids, scoped to a space. Mirrors the batch
 *  `.in('id', ids).eq('spaceId', spaceId)` reads in attach-file-to-product (one
 *  id today but kept batch-shaped), deals/[id]/documents, send_email, send_sms.
 *  Returns full rows; callers pick the columns they need. */
export const listByIdsForSpace = query({
  args: { ids: v.array(v.string()), spaceId: v.string() },
  handler: async (ctx, args) => {
    const out: ReturnType<typeof toFileRow>[] = [];
    for (const id of args.ids) {
      const f = await ctx.db
        .query('File')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (f && f.spaceId === args.spaceId) out.push(toFileRow(f));
    }
    return out;
  },
});

/** storage-key lookup for studio library signing: rows matching a set of ids
 *  (no space scope — the caller already owns the ids via the job rows). Mirrors
 *  `.from('File').select('id, storageKey').in('id', fileIds)`. */
export const storageKeysByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ id: string; storageKey: string }[]> => {
    const out: { id: string; storageKey: string }[] = [];
    for (const id of args.ids) {
      const f = await ctx.db
        .query('File')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (f) out.push({ id: f.id, storageKey: f.storageKey });
    }
    return out;
  },
});

/** storage-gc: of a candidate set of storage keys, which exist in File. Mirrors
 *  `.from('File').select('storageKey').in('storageKey', candidates)` (used for
 *  both the files/ and studio/ prefixes). Returns the referenced subset. */
export const referencedStorageKeys = query({
  args: { candidates: v.array(v.string()) },
  handler: async (ctx, args): Promise<string[]> => {
    const referenced: string[] = [];
    for (const key of args.candidates) {
      const f = await ctx.db
        .query('File')
        .withIndex('by_storage_key', (q) => q.eq('storageKey', key))
        .first();
      if (f) referenced.push(f.storageKey);
    }
    return referenced;
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/** Insert a File row (upload, document create, studio generate/edit all share
 *  this payload). The caller passes the id it already minted (it built the
 *  storageKey from it) and the storage object is uploaded first; on insert
 *  failure the caller rolls back the object. isPublic defaults false.
 *
 *  UNIQUE(storageKey) preserved: read by_storage_key first; on collision throw
 *  so the route's rollback path fires exactly as a PG unique violation did. */
export const create = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    userId: v.string(),
    storageKey: v.string(),
    name: v.string(),
    mimeType: v.string(),
    category: v.string(),
    sizeBytes: v.number(),
    isPublic: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const clash = await ctx.db
      .query('File')
      .withIndex('by_storage_key', (q) => q.eq('storageKey', args.storageKey))
      .first();
    if (clash) {
      // Mirrors the PG unique-violation the insert would have raised.
      throw new Error(`File.storageKey already exists: ${args.storageKey}`);
    }
    const doc = {
      id: args.id,
      spaceId: args.spaceId,
      userId: args.userId,
      storageKey: args.storageKey,
      name: args.name,
      mimeType: args.mimeType,
      category: args.category,
      sizeBytes: args.sizeBytes,
      isPublic: args.isPublic ?? false,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('File', doc);
    return toFileRow(doc);
  },
});

/** Overwrite a document's name+size after its content is re-uploaded in place.
 *  Mirrors PUT /api/files/documents/[id] (`.update({name, sizeBytes}).eq('id')
 *  .eq('spaceId')`). No-op if it vanished or isn't the caller's. */
export const updateDocMeta = mutation({
  args: { id: v.string(), spaceId: v.string(), name: v.string(), sizeBytes: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const f = await ctx.db
      .query('File')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!f || f.spaceId !== args.spaceId) return;
    await ctx.db.patch(f._id, { name: args.name, sizeBytes: args.sizeBytes });
  },
});

/** Delete a File row scoped to a space. Mirrors `.from('File').delete().eq('id')
 *  .eq('spaceId')` (files/[id] DELETE, documents/[id] DELETE). The route does
 *  the storage-object cleanup. Returns the deleted row's storageKey (the route
 *  needs it for the best-effort object delete; today it reads the row first —
 *  returning it here lets the integrator collapse that into one hop). */
export const deleteByIdForSpace = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<{ storageKey: string } | null> => {
    const f = await ctx.db
      .query('File')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!f || f.spaceId !== args.spaceId) return null;
    const storageKey = f.storageKey;
    await ctx.db.delete(f._id);
    return { storageKey };
  },
});
