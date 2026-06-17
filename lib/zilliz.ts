// Vector storage backed by Convex (DocumentEmbedding table + vector search).
// Replaces the previous Supabase pgvector integration — same exported interface
// so lib/vectorize.ts and lib/ai.ts require no import changes.

import { convex, api } from '@/lib/convex-server';

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Upsert (insert or replace) a single embedding row.
 * The `id` is a stable composite key like `contact_<uuid>` or `deal_<uuid>`.
 * The embedding goes to Convex as a raw number[] (v.array(v.float64())); the
 * upsert mutation preserves PK uniqueness by read-by-id then insert-or-patch.
 */
export async function upsertVector(
  spaceId: string,
  id: string,
  entityType: 'contact' | 'deal',
  entityId: string,
  text: string,
  vector: number[]
): Promise<void> {
  await convex().mutation(api.swarmvector.documentEmbedding.upsert, {
    id,
    spaceId,
    entityType,
    entityId,
    content: text,
    embedding: vector,
  });
}

/**
 * Delete the embedding row for a given composite id.
 * The spaceId guard ensures a user can only delete their own vectors.
 */
export async function deleteVector(spaceId: string, id: string): Promise<void> {
  await convex().mutation(api.swarmvector.documentEmbedding.removeInSpace, {
    id,
    spaceId,
  });
}

/**
 * Return the topK most similar documents for the given query vector,
 * scoped strictly to the caller's spaceId so users never see each other's data.
 *
 * If `queryText` is provided, runs hybrid retrieval: BM25 (Postgres
 * tsvector) + cosine fused via RRF. The BM25 leg fixes the failure mode
 * where pure semantic search loses on exact-string matches — addresses
 * ("123 Oak St"), MLS numbers, contact names. When `queryText` is omitted
 * the function degrades to the original cosine-only behavior (caller
 * doesn't have to know which RPC ran).
 */
export async function searchVectors(
  spaceId: string,
  queryVector: number[],
  topK = 5,
  queryText?: string,
): Promise<Array<{ entity_type: string; entity_id: string; text: string; score: number }>> {
  // The query embedding goes to Convex as a raw number[] (no pgvector literal).
  // Both actions already return the { entity_type, entity_id, text, score }
  // shape this function exposes, so there's no row mapping to do.

  // When we have the source text, prefer the hybrid action. The score it
  // returns is the RRF score (sum of 1/(60+rank) across the two legs),
  // not a cosine similarity — different scale, same ordering semantics
  // for the caller's purposes.
  if (queryText && queryText.trim().length > 0) {
    return await convex().action(api.swarmvector.documentEmbedding.matchDocumentsHybrid, {
      queryEmbedding: queryVector,
      queryText,
      spaceId,
      matchCount: topK,
    });
  }

  return await convex().action(api.swarmvector.documentEmbedding.matchDocuments, {
    queryEmbedding: queryVector,
    spaceId,
    matchCount: topK,
  });
}
