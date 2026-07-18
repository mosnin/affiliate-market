import { query, mutation, action, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { v } from 'convex/values';

/**
 * AgentMemory data access — Convex replacement for every `.from('AgentMemory')`
 * read/write AND the `match_agent_memory` pgvector RPC.
 *
 * Non-vector call sites (plain query/mutation, below):
 *   - lib/agent-memory/store.ts storeMemory       -> insert
 *   - app/api/agent/memory/route.ts (GET list)    -> listForSpace
 *   - app/api/agent/memory/[id]/route.ts (DELETE) -> removeInSpace
 *   - app/api/agent/insights/route.ts (GET)       -> insightsForSpace
 *   - app/api/agent/priority/route.ts (GET)       -> latestSpaceMemoryWithPrefix
 *   - app/api/agent/contact/[id] | deal/[id]      -> listForEntity
 *   - app/api/agent/brief/[contactId]             -> listForEntityWithContentPrefixes
 *
 * Vector call sites (action, below):
 *   - lib/agent-memory/store.ts recallMemory         -> matchAgentMemory
 *   - lib/chat/vector-context.ts vectorMemorySearch  -> matchAgentMemory
 *
 * ── VECTOR SEARCH (match_agent_memory) — INTEGRATOR MUST REVIEW ──────────────
 * The Postgres RPC:
 *   SELECT ..., (1 - (embedding <=> q))::float AS similarity
 *   WHERE spaceId = $space AND embedding IS NOT NULL
 *     AND (filter_memory_type IS NULL OR memoryType = $mt)
 *     AND (filter_entity_type IS NULL OR entityType = $et)
 *     AND (filter_entity_id   IS NULL OR entityId   = $eid)
 *     AND (1 - (embedding <=> q)) >= $minSim
 *   ORDER BY embedding <=> q LIMIT $count
 * Convex mapping (`matchAgentMemory` action):
 *   - `1 - cosine_distance` == cosine SIMILARITY == Convex vectorSearch `_score`
 *     (cosine, range -1..1; 1 == identical). So `_score` IS the RPC `similarity`.
 *   - IMPORTANT: Convex's vector `filter` builder supports ONLY `q.eq` and
 *     `q.or` — there is NO `q.and` (see node_modules/convex .../vector_search.d.ts
 *     VectorFilterBuilder). So we CANNOT AND spaceId with the other filters at
 *     search time. We put the ALWAYS-present `spaceId` in the vectorSearch filter
 *     and apply the three CONDITIONAL filters (memoryType/entityType/entityId,
 *     each only when non-null) as a POST-FILTER in TS while loading the rows —
 *     which reproduces the RPC's "IS NULL OR =" AND-chain exactly.
 *   - `min_similarity` likewise has no vectorSearch equivalent -> post-filter
 *     `_score >= minSimilarity` in TS.
 *   - LIMIT: post-filtering (the conditional eq's + minSim) can drop rows, so we
 *     OVER-FETCH from vectorSearch (count * a headroom factor, clamped to the 256
 *     vectorSearch cap), then take `count` after filtering. With tight entity
 *     filters + a large space this CAN under-return vs Postgres (which filters
 *     in-engine then limits); flagged in the report. Widen the headroom or add a
 *     non-vector fallback if recall@k regresses.
 *   - `embedding IS NULL` rows can't appear (no vector indexed) -> matches RPC.
 *   - Tie-break/order: Convex returns by descending `_score`, same order the RPC
 *     gets from ascending cosine distance. Exact tie ordering MAY differ from
 *     Postgres but is not relied on by either caller.
 */

const ENTITY_TYPE = v.union(v.literal('contact'), v.literal('deal'), v.literal('space'));
const MEMORY_TYPE = v.union(
  v.literal('fact'),
  v.literal('preference'),
  v.literal('observation'),
  v.literal('reminder'),
);

type AgentMemoryDoc = {
  id: string;
  spaceId: string;
  entityType?: 'contact' | 'deal' | 'space';
  entityId?: string;
  memoryType: 'fact' | 'preference' | 'observation' | 'reminder';
  content: string;
  embedding?: number[];
  importance: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  sourceRunId?: string;
  sourceToolName?: string;
  sourceConversationId?: string;
};

/**
 * Full legacy AgentMemory row (drop _id/_creationTime + the embedding blob —
 * no call site ever reads the vector back — surface `id`, coerce absent
 * optionals -> null). Callers `.select()` a subset of these columns.
 */
function toRow(d: AgentMemoryDoc) {
  return {
    id: d.id,
    spaceId: d.spaceId,
    entityType: d.entityType ?? null,
    entityId: d.entityId ?? null,
    memoryType: d.memoryType,
    content: d.content,
    importance: d.importance,
    expiresAt: d.expiresAt ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    taskId: d.taskId ?? null,
    sourceRunId: d.sourceRunId ?? null,
    sourceToolName: d.sourceToolName ?? null,
    sourceConversationId: d.sourceConversationId ?? null,
  };
}

// ── Non-vector reads ─────────────────────────────────────────────────────────

/**
 * The user-facing memory list (GET /api/agent/memory). Filters by space, drops
 * coordinator scratch (content LIKE 'PRIORITY_LIST:%'), optional entityType /
 * memoryType filters, optional content substring (case-insensitive), sorted by
 * importance desc then createdAt desc, capped (default 100, route caps at 200).
 * The PRIORITY_LIST exclusion + free-text ILIKE are done in TS (Convex has no
 * server-side LIKE); the dataset per space is small.
 */
export const listForSpace = query({
  args: {
    spaceId: v.string(),
    entityType: v.optional(ENTITY_TYPE),
    memoryType: v.optional(MEMORY_TYPE),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentMemory')
      .withIndex('by_space_entity', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    let out = rows.filter((r) => !r.content.startsWith('PRIORITY_LIST:'));
    if (args.entityType !== undefined) out = out.filter((r) => r.entityType === args.entityType);
    if (args.memoryType !== undefined) out = out.filter((r) => r.memoryType === args.memoryType);
    const search = (args.search ?? '').trim().toLowerCase();
    if (search) out = out.filter((r) => r.content.toLowerCase().includes(search));
    out.sort((a, b) => {
      if (a.importance !== b.importance) return b.importance - a.importance;
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    });
    return out.slice(0, args.limit ?? 100).map(toRow);
  },
});

/**
 * Dashboard insights (GET /api/agent/insights): space memories with importance
 * >= 0.3, newest-first, capped 20. (The route then re-sorts by importance and
 * slices to 8 in JS — that stays in the route. We mirror the DB query only.)
 */
export const insightsForSpace = query({
  args: { spaceId: v.string(), minImportance: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const floor = args.minImportance ?? 0.3;
    const rows = await ctx.db
      .query('AgentMemory')
      .withIndex('by_space_entity', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const out = rows.filter((r) => r.importance >= floor);
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out.slice(0, args.limit ?? 20).map(toRow);
  },
});

/**
 * Memories for one entity (GET /api/agent/contact/[id], /api/agent/deal/[id]):
 * (spaceId, entityType, entityId), importance desc then createdAt desc, cap 20.
 */
export const listForEntity = query({
  args: {
    spaceId: v.string(),
    entityType: ENTITY_TYPE,
    entityId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentMemory')
      .withIndex('by_space_entity', (q) =>
        q.eq('spaceId', args.spaceId).eq('entityType', args.entityType).eq('entityId', args.entityId),
      )
      .collect();
    rows.sort((a, b) => {
      if (a.importance !== b.importance) return b.importance - a.importance;
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    });
    return rows.slice(0, args.limit ?? 20).map(toRow);
  },
});

/**
 * The single most-recent space memory whose content starts with `prefix`
 * (GET /api/agent/priority uses prefix 'PRIORITY_LIST:'). Mirrors
 * `.eq(space).eq(entityType,'space').eq(entityId,space).like(content,'pfx%')
 *  .order(createdAt desc).limit(1).maybeSingle()`. Returns the row or null.
 */
export const latestSpaceMemoryWithPrefix = query({
  args: { spaceId: v.string(), prefix: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentMemory')
      .withIndex('by_space_entity', (q) =>
        q.eq('spaceId', args.spaceId).eq('entityType', 'space').eq('entityId', args.spaceId),
      )
      .collect();
    const matching = rows.filter((r) => r.content.startsWith(args.prefix));
    matching.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return matching.length ? toRow(matching[0]) : null;
  },
});

/**
 * Contact/deal memories whose content starts with ANY of the given prefixes
 * (GET /api/agent/brief/[contactId] uses ['AGENT_BRIEF:','SCORE_EXPLANATION:']),
 * newest-first, cap 10. Mirrors the `.or('content.like.A%,content.like.B%')`.
 */
export const listForEntityWithContentPrefixes = query({
  args: {
    spaceId: v.string(),
    entityType: ENTITY_TYPE,
    entityId: v.string(),
    prefixes: v.array(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentMemory')
      .withIndex('by_space_entity', (q) =>
        q.eq('spaceId', args.spaceId).eq('entityType', args.entityType).eq('entityId', args.entityId),
      )
      .collect();
    const out = rows.filter((r) => args.prefixes.some((p) => r.content.startsWith(p)));
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out.slice(0, args.limit ?? 10).map(toRow);
  },
});

// ── Non-vector writes ────────────────────────────────────────────────────────

/**
 * Insert a memory (lib/agent-memory/store.ts storeMemory). The embedding is
 * computed in lib (OpenAI) and passed in as number[] — storeMemory throws if
 * embedding fails, so embedding is REQUIRED here (no null-embedding rows from
 * this path, matching the lib's strictness). importance is clamped 0..1 in lib;
 * we store it verbatim. entityType/entityId come pre-resolved by the lib's
 * resolveEntity. Returns { id } (the only field storeMemory uses).
 *
 * NOTE: the lib currently passes the embedding to Postgres as a string literal
 * '[...]'. The integrator's lib rewrite must pass the raw number[] instead
 * (Convex stores v.array(v.float64())). Flagged in the report.
 */
export const insert = mutation({
  args: {
    spaceId: v.string(),
    entityType: ENTITY_TYPE,
    entityId: v.string(),
    memoryType: MEMORY_TYPE,
    content: v.string(),
    embedding: v.array(v.float64()),
    importance: v.optional(v.number()),
    expiresAt: v.optional(v.string()),
    taskId: v.optional(v.string()),
    sourceRunId: v.optional(v.string()),
    sourceToolName: v.optional(v.string()),
    sourceConversationId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ id: string }> => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await ctx.db.insert('AgentMemory', {
      id,
      spaceId: args.spaceId,
      entityType: args.entityType,
      entityId: args.entityId,
      memoryType: args.memoryType,
      content: args.content,
      embedding: args.embedding,
      importance: args.importance ?? 0.5,
      expiresAt: args.expiresAt,
      createdAt: now,
      updatedAt: now,
      taskId: args.taskId,
      sourceRunId: args.sourceRunId,
      sourceToolName: args.sourceToolName,
      sourceConversationId: args.sourceConversationId,
    });
    return { id };
  },
});

/**
 * Delete one memory by id, scoped to a space (DELETE /api/agent/memory/[id]).
 * Returns { ok } — ok:false (not_found) when the id isn't in this space, so the
 * route keeps its 404 (which it returns indistinguishably from "exists in
 * another space" to avoid cross-tenant existence leaks).
 */
export const removeInSpace = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const d = await ctx.db
      .query('AgentMemory')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d || d.spaceId !== args.spaceId) return { ok: false };
    await ctx.db.delete(d._id);
    return { ok: true };
  },
});

// ── Vector recall (match_agent_memory) ───────────────────────────────────────

/**
 * match_agent_memory — semantic recall over a space's memories.
 *
 * Action because ctx.vectorSearch is action-only. Returns rows in the SAME shape
 * the RPC returned (id, content, memoryType, entityType, entityId, importance,
 * similarity, createdAt), already filtered by min_similarity and capped at
 * matchCount, ranked by cosine similarity desc.
 *
 * `queryEmbedding` is the pre-computed query vector (number[1536]); the lib
 * embeds the query (OpenAI) before calling — same as it does for Postgres today
 * (it passed a vector literal to the RPC; the integrator's lib rewrite passes
 * the raw number[] here).
 */
export const matchAgentMemory = action({
  args: {
    queryEmbedding: v.array(v.float64()),
    spaceId: v.string(),
    matchCount: v.optional(v.number()),
    filterMemoryType: v.optional(v.union(MEMORY_TYPE, v.null())),
    filterEntityType: v.optional(v.union(ENTITY_TYPE, v.null())),
    filterEntityId: v.optional(v.union(v.string(), v.null())),
    minSimilarity: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{
      id: string;
      content: string;
      memoryType: 'fact' | 'preference' | 'observation' | 'reminder';
      entityType: 'contact' | 'deal' | 'space' | null;
      entityId: string | null;
      importance: number;
      similarity: number;
      createdAt: string;
    }>
  > => {
    const count = Math.max(1, Math.min(256, args.matchCount ?? 6));
    const minSim = args.minSimilarity ?? 0;

    // vectorSearch filter: only spaceId (the always-present filter). The OTHER
    // filters can't be AND-ed in the vector filter (no q.and) — they're applied
    // in the loader. Over-fetch so post-filtering still yields up to `count`.
    const hasExtraFilters =
      args.filterMemoryType != null || args.filterEntityType != null || args.filterEntityId != null;
    const fetchLimit = Math.min(256, hasExtraFilters || minSim > 0 ? count * 8 : count);

    const hits = await ctx.vectorSearch('AgentMemory', 'by_embedding', {
      vector: args.queryEmbedding,
      limit: fetchLimit,
      filter: (q) => q.eq('spaceId', args.spaceId),
    });

    // Apply the minSim floor here (cheap, no row load needed); the remaining
    // conditional filters need the doc fields, so they run in the loader. Keep
    // ranked order (vectorSearch already returns _score desc).
    const ranked = hits
      .filter((h) => h._score >= minSim)
      .map((h) => ({ id: h._id as unknown as string, score: h._score }));

    return await ctx.runQuery(internal.swarmvector.agentMemory._loadByDocIdsWithScore, {
      hits: ranked,
      limit: count,
      filterMemoryType: args.filterMemoryType ?? null,
      filterEntityType: args.filterEntityType ?? null,
      filterEntityId: args.filterEntityId ?? null,
    });
  },
});

/**
 * Internal loader keyed by Convex _id (what vectorSearch returns). Loads each
 * ranked hit, applies the conditional memoryType/entityType/entityId filters
 * (the AND-chain the vector filter couldn't express), keeps ranked order, zips
 * the score in, and stops at `limit`. Drops rows that vanished between search
 * and load (race-safe). Output mirrors match_agent_memory's projection.
 */
export const _loadByDocIdsWithScore = internalQuery({
  args: {
    hits: v.array(v.object({ id: v.string(), score: v.number() })),
    limit: v.number(),
    filterMemoryType: v.union(MEMORY_TYPE, v.null()),
    filterEntityType: v.union(ENTITY_TYPE, v.null()),
    filterEntityId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const out: Array<{
      id: string;
      content: string;
      memoryType: 'fact' | 'preference' | 'observation' | 'reminder';
      entityType: 'contact' | 'deal' | 'space' | null;
      entityId: string | null;
      importance: number;
      similarity: number;
      createdAt: string;
    }> = [];
    for (const hit of args.hits) {
      if (out.length >= args.limit) break;
      const d = await ctx.db.get(hit.id as Id<'AgentMemory'>);
      if (!d) continue;
      // Conditional AND filters (each only when non-null), == the RPC predicates.
      if (args.filterMemoryType != null && d.memoryType !== args.filterMemoryType) continue;
      if (args.filterEntityType != null && d.entityType !== args.filterEntityType) continue;
      if (args.filterEntityId != null && d.entityId !== args.filterEntityId) continue;
      out.push({
        id: d.id,
        content: d.content,
        memoryType: d.memoryType,
        entityType: d.entityType ?? null,
        entityId: d.entityId ?? null,
        importance: d.importance,
        similarity: hit.score,
        createdAt: d.createdAt,
      });
    }
    return out;
  },
});
