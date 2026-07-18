import { mutation, action, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { v } from 'convex/values';

/**
 * DocumentEmbedding data access — Convex replacement for lib/zilliz.ts (the
 * pgvector-backed vector store: upsertVector / deleteVector / searchVectors) AND
 * the `match_documents` + `match_documents_hybrid` RPCs.
 *
 * Call sites (all in lib/zilliz.ts, used by lib/vectorize.ts + lib/ai.ts):
 *   - upsertVector  -> upsert            (insert-or-replace by composite id)
 *   - deleteVector  -> removeInSpace     (delete by id, spaceId-guarded)
 *   - searchVectors -> matchDocuments / matchDocumentsHybrid (action)
 *
 * Composite id: the caller supplies a STABLE id like `contact_<uuid>` /
 * `deal_<uuid>` (PG PK(id), upsert onConflict 'id'). Uniqueness is preserved by
 * the upsert mutation reading-by-id then insert-or-patch (serializable).
 *
 * ── VECTOR SEARCH — INTEGRATOR MUST REVIEW ───────────────────────────────────
 * `match_documents` (cosine-only) translates cleanly:
 *   SELECT id, entityType AS entity_type, entityId AS entity_id, content,
 *          1 - (embedding <=> q) AS similarity
 *   WHERE spaceId = $space AND embedding IS NOT NULL
 *   ORDER BY embedding <=> q LIMIT $count
 * -> `matchDocuments` action: vectorSearch filtered by spaceId, `_score` IS the
 *    cosine `similarity`, mapped to { entity_type, entity_id, text, score }.
 *
 * `match_documents_hybrid` is the LEAST faithful translation in this domain.
 * Postgres fuses two legs with Reciprocal Rank Fusion (RRF):
 *   cosine leg: top (count*4) by embedding distance,   rank r -> 1/(rrf_k + r)
 *   BM25  leg : top (count*4) by ts_rank_cd(tsv, q),   rank r -> 1/(rrf_k + r)
 *   fused score = cosScore + bm25Score; keep score>0; order desc; limit count.
 * Convex has NO tsvector / ts_rank_cd / GENERATED column. The hybrid action
 * below REIMPLEMENTS the BM25 leg in TS as a lightweight lexical rank over a
 * candidate set (the space's docs), then fuses with the SAME RRF math + rrf_k.
 * Caveats the integrator must weigh:
 *   - The TS lexical scorer is NOT Postgres BM25/ts_rank_cd. Ranking WILL differ
 *     for ties and partial matches. The RRF *shape* (rank reciprocals, k=60,
 *     additive fusion, score-desc, limit) is preserved exactly; the per-leg
 *     RANKING inside it is approximate.
 *   - Postgres scans the WHOLE space for the BM25 leg via the tsv GIN index.
 *     Here we vector-search a candidate window for the cosine leg and scan the
 *     space's rows for the lexical leg. For the lexical candidate set we cap the
 *     scan; a space with a very large DocumentEmbedding table would need a real
 *     text index (Convex search index) — flagged. Today's data is per-space and
 *     small, so a bounded scan is acceptable.
 *   - lib/zilliz.searchVectors already FALLS BACK to cosine-only when the hybrid
 *     RPC is missing; if the integrator decides the TS BM25 approximation isn't
 *     good enough, pointing searchVectors at `matchDocuments` (cosine-only) is a
 *     safe, lossless-vs-today degrade (that's the same fallback the lib has).
 *
 * ALTERNATIVE the integrator should consider: add a Convex SEARCH INDEX
 * (.searchIndex on `content`) and run the keyword leg as a real full-text query
 * instead of the TS scorer. It needs its own action round (search indexes are
 * query-time, like vector indexes) and a second fan-out; left out of phase 1 to
 * keep this to ONE extra index per table, but it's the right hardening.
 */

const RRF_K = 60; // matches match_documents_hybrid's rrf_k default

type DocumentEmbeddingDoc = {
  id: string;
  spaceId: string;
  entityType: string;
  entityId: string;
  content: string;
  embedding?: number[];
};

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Upsert a single embedding row (lib/zilliz.upsertVector). Insert-or-replace
 * keyed on the composite `id` (PG ON CONFLICT (id) DO UPDATE). Read-by-id then
 * insert-or-patch inside one serializable mutation preserves the PK uniqueness.
 * `embedding` is the raw number[1536] (lib passed a PG vector literal; the lib
 * rewrite passes the array). entityType is free text in PG ('contact'|'deal').
 */
export const upsert = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    content: v.string(),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query('DocumentEmbedding')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    const fields = {
      id: args.id,
      spaceId: args.spaceId,
      entityType: args.entityType,
      entityId: args.entityId,
      content: args.content,
      embedding: args.embedding,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert('DocumentEmbedding', fields);
    }
  },
});

/**
 * Delete an embedding row by composite id, scoped to the space
 * (lib/zilliz.deleteVector — the spaceId guard stops a caller deleting another
 * space's vector). No-op when the id isn't this space's. Returns nothing (the
 * lib ignores the result; it only cares about thrown errors).
 */
export const removeInSpace = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const d = await ctx.db
      .query('DocumentEmbedding')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d || d.spaceId !== args.spaceId) return;
    await ctx.db.delete(d._id);
  },
});

// ── Internal loaders (actions can't touch ctx.db) ─────────────────────────────

/**
 * Load DocumentEmbedding rows by Convex _id (what vectorSearch returns),
 * preserving order, zipping in the supplied score. Returns the searchVectors
 * row shape directly: { entity_type, entity_id, text, score }.
 */
export const _loadByDocIdsWithScore = internalQuery({
  args: { hits: v.array(v.object({ id: v.string(), score: v.number() })) },
  handler: async (ctx, args) => {
    const out: Array<{ entity_type: string; entity_id: string; text: string; score: number }> = [];
    for (const hit of args.hits) {
      const d = await ctx.db.get(hit.id as Id<'DocumentEmbedding'>);
      if (!d) continue;
      out.push({
        entity_type: d.entityType,
        entity_id: d.entityId,
        text: d.content,
        score: hit.score,
      });
    }
    return out;
  },
});

/**
 * The space's docs for the hybrid keyword (BM25-approx) leg. Returns the minimal
 * fields the lexical scorer + fusion need: Convex _id (to fuse with the cosine
 * leg, which is keyed by _id), the composite id, entity fields, and content.
 * Capped to bound the scan (the BM25 leg only needs a candidate pool to rank).
 */
export const _spaceDocsForLexical = internalQuery({
  args: { spaceId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DocumentEmbedding')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .take(args.limit ?? 2000);
    return rows
      .filter((r) => r.embedding != null) // RPC's `embedding IS NOT NULL` for symmetry
      .map((r) => ({
        docId: r._id as unknown as string,
        entityType: r.entityType,
        entityId: r.entityId,
        text: r.content,
      }));
  },
});

// ── Vector search (match_documents) ──────────────────────────────────────────

/**
 * match_documents — cosine-only top-K over a space's documents.
 * `queryEmbedding` is the pre-computed query vector. Returns rows in the
 * searchVectors shape: { entity_type, entity_id, text, score } where score is
 * the cosine similarity (== Convex `_score` == RPC `1 - distance`).
 */
export const matchDocuments = action({
  args: {
    queryEmbedding: v.array(v.float64()),
    spaceId: v.string(),
    matchCount: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ entity_type: string; entity_id: string; text: string; score: number }>> => {
    const count = Math.max(1, Math.min(256, args.matchCount ?? 5));
    const hits = await ctx.vectorSearch('DocumentEmbedding', 'by_embedding', {
      vector: args.queryEmbedding,
      limit: count,
      filter: (q) => q.eq('spaceId', args.spaceId),
    });
    const ranked = hits.map((h) => ({ id: h._id as unknown as string, score: h._score }));
    return await ctx.runQuery(internal.swarmvector.documentEmbedding._loadByDocIdsWithScore, {
      hits: ranked,
    });
  },
});

// ── Hybrid vector + lexical search (match_documents_hybrid) ───────────────────

/** Tokenise to lowercase alphanumeric word stems (cheap; NOT Postgres' english
 *  text-search config — approximation, see file header). */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
}

/**
 * Lightweight lexical relevance score for one document given the query tokens.
 * Sums per-query-term term-frequency (a coarse stand-in for ts_rank_cd). Returns
 * 0 when no query term appears — those docs are EXCLUDED from the BM25 leg,
 * matching the RPC's `WHERE tsv @@ ts_query` (only matching rows enter the leg).
 */
function lexicalScore(content: string, queryTerms: Set<string>): number {
  if (queryTerms.size === 0) return 0;
  const docTokens = tokenize(content);
  if (docTokens.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const tok of docTokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
  let score = 0;
  for (const term of queryTerms) score += tf.get(term) ?? 0;
  return score;
}

/**
 * match_documents_hybrid — RRF fusion of a cosine leg and a lexical (BM25-approx)
 * leg. See the file header for the fidelity caveats. The fusion math mirrors the
 * SQL exactly:
 *   cosine leg : top (count*4) by vector similarity, rank r (1-based) -> 1/(K+r)
 *   lexical leg: top (count*4) by lexicalScore over the space's matching docs,
 *                rank r (1-based) -> 1/(K+r)
 *   fused score = cosineRRF + lexicalRRF ; keep score>0 ; order desc ; limit count
 * Keyed by Convex _id so the two legs fuse on the same identity, exactly as the
 * SQL fuses on de.id.
 */
export const matchDocumentsHybrid = action({
  args: {
    queryEmbedding: v.array(v.float64()),
    queryText: v.string(),
    spaceId: v.string(),
    matchCount: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ entity_type: string; entity_id: string; text: string; score: number }>> => {
    const count = Math.max(1, Math.min(256, args.matchCount ?? 5));
    const legLimit = count * 4; // RPC uses match_count * 4 per leg

    // ── Cosine leg: top (count*4) by vector similarity, 1-based rank. ─────────
    const cosineHits = await ctx.vectorSearch('DocumentEmbedding', 'by_embedding', {
      vector: args.queryEmbedding,
      limit: Math.min(256, legLimit),
      filter: (q) => q.eq('spaceId', args.spaceId),
    });
    const cosineRank = new Map<string, number>(); // docId -> rank (1-based)
    cosineHits.forEach((h, i) => cosineRank.set(h._id as unknown as string, i + 1));

    // ── Lexical leg: rank the space's matching docs by lexicalScore, take 4x. ──
    const queryTerms = new Set(tokenize(args.queryText));
    const lexicalRank = new Map<string, number>(); // docId -> rank (1-based)
    if (queryTerms.size > 0) {
      const docs = await ctx.runQuery(
        internal.swarmvector.documentEmbedding._spaceDocsForLexical,
        { spaceId: args.spaceId },
      );
      const scored = docs
        .map((d) => ({ docId: d.docId, score: lexicalScore(d.text, queryTerms) }))
        .filter((d) => d.score > 0) // only matching rows enter the BM25 leg (tsv @@ q)
        .sort((a, b) => b.score - a.score)
        .slice(0, legLimit);
      scored.forEach((d, i) => lexicalRank.set(d.docId, i + 1));
    }

    // ── Fuse (RRF) ────────────────────────────────────────────────────────────
    const ids = new Set<string>([...cosineRank.keys(), ...lexicalRank.keys()]);
    const fused: Array<{ id: string; score: number }> = [];
    for (const id of ids) {
      const cr = cosineRank.get(id);
      const lr = lexicalRank.get(id);
      const score =
        (cr !== undefined ? 1 / (RRF_K + cr) : 0) + (lr !== undefined ? 1 / (RRF_K + lr) : 0);
      if (score > 0) fused.push({ id, score });
    }
    fused.sort((a, b) => b.score - a.score);
    const top = fused.slice(0, count);

    return await ctx.runQuery(internal.swarmvector.documentEmbedding._loadByDocIdsWithScore, {
      hits: top,
    });
  },
});
