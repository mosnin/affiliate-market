import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * DealDocument data access — Convex replacement for `.from('DealDocument')`
 * reads/writes (documents GET/POST/DELETE, deal detail, contact detail, packets
 * validate/serve, storage-gc reference check, e-sign send, account export, deal
 * delete storage cleanup).
 *
 * The actual blob lives in object storage; these rows hold the storagePath +
 * metadata. Blob upload/delete stays in the route (it talks to the storage SDK);
 * this module only swaps the DealDocument table hop. The deal DELETE route reads
 * a deal's docs (listByDeal) to gather storagePaths for blob cleanup BEFORE the
 * Deal cascade removes the rows.
 */

const kindValidator = v.union(
  v.literal('offer'),
  v.literal('counter_offer'),
  v.literal('purchase_agreement'),
  v.literal('inspection_report'),
  v.literal('appraisal'),
  v.literal('loan_estimate'),
  v.literal('closing_disclosure'),
  v.literal('title_commitment'),
  v.literal('photo'),
  v.literal('other'),
);

type DocumentFields = {
  id: string;
  dealId: string;
  spaceId: string;
  kind:
    | 'offer'
    | 'counter_offer'
    | 'purchase_agreement'
    | 'inspection_report'
    | 'appraisal'
    | 'loan_estimate'
    | 'closing_disclosure'
    | 'title_commitment'
    | 'photo'
    | 'other';
  label: string;
  storagePath: string;
  contentType?: string;
  sizeBytes?: number;
  uploadedById?: string;
  createdAt: string;
};

function toRow(d: DocumentFields) {
  return {
    id: d.id,
    dealId: d.dealId,
    spaceId: d.spaceId,
    kind: d.kind,
    label: d.label,
    storagePath: d.storagePath,
    contentType: d.contentType ?? null,
    sizeBytes: d.sizeBytes ?? null,
    uploadedById: d.uploadedById ?? null,
    createdAt: d.createdAt,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** One document by id, optionally scoped to dealId/spaceId, or null (documents
 *  GET-by-id, packet doc serve, e-sign send load). Mirrors `.eq('id')[.eq(
 *  'dealId')][.eq('spaceId')].maybeSingle()`. */
export const getById = query({
  args: { id: v.string(), dealId: v.optional(v.string()), spaceId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('DealDocument')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d) return null;
    if (args.dealId !== undefined && d.dealId !== args.dealId) return null;
    if (args.spaceId !== undefined && d.spaceId !== args.spaceId) return null;
    return toRow(d);
  },
});

/** A deal's documents newest-first, optionally space-scoped (documents GET, deal
 *  detail, deal delete cleanup). Replaces `.eq('dealId', id)[.eq('spaceId')].
 *  order('createdAt', desc)`. Rides by_deal_created. */
export const listByDeal = query({
  args: { dealId: v.string(), spaceId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DealDocument')
      .withIndex('by_deal_created', (q) => q.eq('dealId', args.dealId))
      .order('desc')
      .collect();
    const scoped =
      args.spaceId !== undefined ? rows.filter((d) => d.spaceId === args.spaceId) : rows;
    return scoped.map(toRow);
  },
});

/** Documents across several deals in a space, newest-first (contact-detail
 *  attachments list). Replaces `.in('dealId', dealIds).eq('spaceId').order(
 *  'createdAt', desc)`. Fans out per deal; merges newest-first. */
export const listByDeals = query({
  args: { dealIds: v.array(v.string()), spaceId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const all: DocumentFields[] = [];
    for (const dealId of args.dealIds) {
      const rows = await ctx.db
        .query('DealDocument')
        .withIndex('by_deal_created', (q) => q.eq('dealId', dealId))
        .collect();
      for (const d of rows) {
        if (args.spaceId !== undefined && d.spaceId !== args.spaceId) continue;
        all.push(d);
      }
    }
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return all.map(toRow);
  },
});

/** Validate that given document ids exist in a space (packets build: keep only
 *  ids that belong). Replaces `.in('id', includeIds).eq('spaceId').select('id')`.
 *  Returns the subset of ids that exist in the space. */
export const validateIds = query({
  args: { ids: v.array(v.string()), spaceId: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const ok: string[] = [];
    for (const id of args.ids) {
      const d = await ctx.db
        .query('DealDocument')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (d && d.spaceId === args.spaceId) ok.push(id);
    }
    return ok;
  },
});

/** Resolve several documents by id within a space (the public packet page lists
 *  its included docs). Replaces `.in('id', documentIds).eq('spaceId')`. Returns
 *  full rows (the page reads id/label/kind/sizeBytes/contentType/createdAt). */
export const listByIds = query({
  args: { ids: v.array(v.string()), spaceId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const out: DocumentFields[] = [];
    for (const id of args.ids) {
      const d = await ctx.db
        .query('DealDocument')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (!d) continue;
      if (args.spaceId !== undefined && d.spaceId !== args.spaceId) continue;
      out.push(d);
    }
    return out.map(toRow);
  },
});

/** Which of the given storagePaths are still referenced by a DealDocument
 *  (storage-gc orphan sweep: a blob with no referencing row is deletable).
 *  Replaces `.in('storagePath', candidates).select('storagePath')`. Returns the
 *  referenced subset. */
export const referencedStoragePaths = query({
  args: { storagePaths: v.array(v.string()) },
  handler: async (ctx, args): Promise<string[]> => {
    const referenced: string[] = [];
    for (const path of args.storagePaths) {
      const d = await ctx.db
        .query('DealDocument')
        .withIndex('by_storage_path', (q) => q.eq('storagePath', path))
        .first();
      if (d) referenced.push(path);
    }
    return referenced;
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────

/** Insert one document (documents POST upload, e-sign signed-copy save).
 *  Replaces `.insert({...}).select().single()`. contentType/sizeBytes/
 *  uploadedById optional (SQL NULL when omitted). Returns the inserted row. */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    dealId: v.string(),
    spaceId: v.string(),
    kind: kindValidator,
    label: v.string(),
    storagePath: v.string(),
    contentType: v.union(v.string(), v.null()),
    sizeBytes: v.union(v.number(), v.null()),
    uploadedById: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      dealId: args.dealId,
      spaceId: args.spaceId,
      kind: args.kind,
      label: args.label,
      storagePath: args.storagePath,
      ...(args.contentType !== null ? { contentType: args.contentType } : {}),
      ...(args.sizeBytes !== null ? { sizeBytes: args.sizeBytes } : {}),
      ...(args.uploadedById !== null ? { uploadedById: args.uploadedById } : {}),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('DealDocument', doc);
    return toRow(doc);
  },
});

/** Insert several documents in one mutation (documents POST attach-from-Files:
 *  one row per selected file). Replaces `.insert([...]).select()`. Returns the
 *  inserted rows. */
export const createMany = mutation({
  args: {
    docs: v.array(
      v.object({
        id: v.optional(v.string()),
        dealId: v.string(),
        spaceId: v.string(),
        kind: kindValidator,
        label: v.string(),
        storagePath: v.string(),
        contentType: v.union(v.string(), v.null()),
        sizeBytes: v.union(v.number(), v.null()),
        uploadedById: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const out: ReturnType<typeof toRow>[] = [];
    for (const d of args.docs) {
      const doc = {
        id: d.id ?? crypto.randomUUID(),
        dealId: d.dealId,
        spaceId: d.spaceId,
        kind: d.kind,
        label: d.label,
        storagePath: d.storagePath,
        ...(d.contentType !== null ? { contentType: d.contentType } : {}),
        ...(d.sizeBytes !== null ? { sizeBytes: d.sizeBytes } : {}),
        ...(d.uploadedById !== null ? { uploadedById: d.uploadedById } : {}),
        createdAt: now,
      };
      await ctx.db.insert('DealDocument', doc);
      out.push(toRow(doc));
    }
    return out;
  },
});

/** Delete a document by id, scoped to dealId + spaceId (documents DELETE; the
 *  route deletes the blob first). Replaces `.delete().eq('id').eq('dealId').
 *  eq('spaceId')`. Returns the deleted row (so the caller has its storagePath),
 *  or null on mismatch. */
export const deleteById = mutation({
  args: { id: v.string(), dealId: v.optional(v.string()), spaceId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('DealDocument')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d) return null;
    if (args.dealId !== undefined && d.dealId !== args.dealId) return null;
    if (args.spaceId !== undefined && d.spaceId !== args.spaceId) return null;
    const row = toRow(d);
    await ctx.db.delete(d._id);
    return row;
  },
});
