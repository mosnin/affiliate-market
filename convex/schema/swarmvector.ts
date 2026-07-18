import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Swarm + vector domain tables. See convex/CONVENTIONS.md for the Postgres ->
 * Convex translation rules every table here follows (string `id`, ISO
 * timestamps as v.string(), CHECK enums -> v.union of v.literal, nullable ->
 * v.optional, jsonb -> v.any, integer counts/cents -> v.number NEVER float,
 * bool -> v.boolean).
 *
 * Two halves:
 *   1. Swarm orchestration (SwarmRun / SwarmMember / SwarmEvent) — ordinary
 *      relational tables, looked up by id, by space, by parent run, ordered by
 *      wave / createdAt. Plain query/mutation in swarmRuns.ts/swarmMembers.ts/
 *      swarmEvents.ts.
 *   2. pgvector-backed semantic stores (AgentMemory / DocumentEmbedding) — each
 *      carries a 1536-dim embedding (OpenAI text-embedding-3-small, see
 *      lib/agent-memory/embed.ts EMBED_DIMS) and is searched in Postgres via
 *      cosine-distance RPCs. In Convex these become `.vectorIndex(...)` declared
 *      below, queried from an `action` (ctx.vectorSearch is action-only). See
 *      agentMemory.ts / documentEmbedding.ts for the action-side reimplementation
 *      of match_agent_memory / match_documents / match_documents_hybrid.
 *
 * VECTOR-SEARCH CAVEATS the integrator MUST review (flagged in the report too):
 *   - Convex vectorSearch ranks by cosine SIMILARITY and returns `_score`
 *     (-1..1, where 1 == identical). The Postgres RPCs return
 *     `similarity = 1 - (embedding <=> query)` — for cosine distance that is the
 *     SAME cosine-similarity number. So `_score` maps directly to the RPC's
 *     `similarity`. The actions expose `_score` as `similarity`/`score` to
 *     preserve the caller's row shape.
 *   - Convex vectorIndex `filterFields` only support EQUALITY filters (and they
 *     must be declared up front). match_agent_memory's NULLABLE filters
 *     (filter_memory_type / filter_entity_type / filter_entity_id, each applied
 *     only when non-null) are reproduced by conditionally adding an
 *     `.eq(field, value)` to the vectorSearch filter when the arg is present.
 *   - match_agent_memory's `min_similarity` floor and match_documents_hybrid's
 *     BM25 (tsvector) leg + RRF fusion have NO Convex-native equivalent. They are
 *     reimplemented in TS inside the action (post-filter by score; keyword leg
 *     over the candidate set). See documentEmbedding.ts for the hybrid caveat —
 *     it is the least faithful translation and the one most worth a second look.
 *
 * NOTE — schema drift in the directive write path (flagged, NOT modelled here):
 * app/api/agent/directive/route.ts upserts AgentMemory with `memoryType:
 * 'directive'`, a `key` column, and `onConflict: 'key'`. NEITHER the `key`
 * column NOR the 'directive' enum value exists in the authoritative
 * schema.current.sql (memoryType CHECK is fact|preference|observation|reminder;
 * there is no key column / unique index). That route is already broken against
 * the live schema. We model the AUTHORITATIVE schema; the directive route is
 * called out in the report as a pre-existing bug for the integrator to resolve
 * (it is not a swarmvector data-layer concern to invent a column for).
 */
export const swarmvectorTables = {
  // Was: "SwarmRun" (TEXT id default gen_random_uuid()::text, spaceId, goal,
  // status default 'queued' CHECK enum, plan jsonb nullable, result nullable,
  // errorMessage nullable, totalCostCents int default 0, createdAt, completedAt
  // nullable). status enum is the SwarmRun lifecycle.
  SwarmRun: defineTable({
    id: v.string(),
    spaceId: v.string(),
    goal: v.string(),
    status: v.union(
      v.literal('queued'),
      v.literal('planning'),
      v.literal('running'),
      v.literal('auditing'),
      v.literal('completed'),
      v.literal('failed'),
      v.literal('cancelled'),
    ),
    plan: v.optional(v.any()), // jsonb (nullable)
    result: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    totalCostCents: v.number(), // integer cents
    createdAt: v.string(), // ISO-8601
    completedAt: v.optional(v.string()),
  })
    // GET /api/swarm/[runId], cancel, stream, detail page resolve a run by id
    // (often + spaceId guard applied in-handler). PG looked up by PK.
    .index('by_app_id', ['id'])
    // GET /api/swarm + swarm list page + delegate-task list a space's runs
    // newest-first (SwarmRun_spaceId_createdAt_idx = (spaceId, createdAt DESC)).
    .index('by_space_created', ['spaceId', 'createdAt']),

  // Was: "SwarmMember" (TEXT id default gen_random_uuid()::text, swarmRunId,
  // customAgentId nullable, name, role nullable, systemPrompt default '', task,
  // status default 'queued' CHECK enum, output nullable, wave int default 1,
  // costCents int default 0, startedAt nullable, completedAt nullable,
  // createdAt). FK swarmRunId -> SwarmRun ON DELETE CASCADE (re-implemented as
  // an explicit cascade in swarmRuns.remove if/when a run delete exists; no run
  // delete call site exists today, so the cascade is documented, not wired).
  SwarmMember: defineTable({
    id: v.string(),
    swarmRunId: v.string(),
    customAgentId: v.optional(v.string()),
    name: v.string(),
    role: v.optional(v.string()),
    systemPrompt: v.string(), // default ''
    task: v.string(),
    status: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('completed'),
      v.literal('failed'),
    ),
    output: v.optional(v.string()),
    wave: v.number(), // integer (default 1)
    costCents: v.number(), // integer cents (default 0)
    startedAt: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // GET /api/swarm/[runId] + run detail page list members for a run
    // (page orders by wave asc; route is unordered) — SwarmMember_swarmRunId_idx.
    .index('by_run', ['swarmRunId'])
    // by_app_id: the Modal runner patches members by id; no TS call site reads a
    // member by id today, but the id lookup is the natural write key and keeps
    // the table consistent with the others. Cheap, and the integrator needs it
    // the moment the runner's writes move to Convex.
    .index('by_app_id', ['id']),

  // Was: "SwarmEvent" (TEXT id default gen_random_uuid()::text, swarmRunId,
  // memberId nullable, type, data jsonb default '{}', createdAt). FK swarmRunId
  // -> SwarmRun ON DELETE CASCADE, memberId -> SwarmMember ON DELETE SET NULL.
  // Append-only event log; the SSE stream polls it by (run, createdAt).
  SwarmEvent: defineTable({
    id: v.string(),
    swarmRunId: v.string(),
    memberId: v.optional(v.string()),
    type: v.string(),
    data: v.any(), // jsonb (default {})
    createdAt: v.string(), // ISO-8601
  })
    // The SSE stream polls a run's events created after a cursor, oldest-first
    // (SwarmEvent_swarmRunId_createdAt_idx = (swarmRunId, createdAt)).
    .index('by_run_created', ['swarmRunId', 'createdAt']),

  // Was: "AgentMemory" (TEXT id default gen_random_uuid()::text, spaceId,
  // entityType nullable CHECK in (contact,deal,space), entityId nullable,
  // memoryType CHECK in (fact,preference,observation,reminder), content,
  // embedding vector(1536) nullable, importance double precision default 0.5,
  // expiresAt nullable, createdAt, updatedAt, taskId nullable, sourceRunId
  // nullable, sourceToolName nullable, sourceConversationId nullable).
  //
  // importance is a 0-1 SCORE (double precision), NOT money — v.number is fine
  // (CONVENTIONS' "integer cents" rule is about money; this is a ranking float).
  // embedding is v.array(v.float64()) and ALSO backs the vector index below.
  AgentMemory: defineTable({
    id: v.string(),
    spaceId: v.string(),
    entityType: v.optional(
      v.union(v.literal('contact'), v.literal('deal'), v.literal('space')),
    ),
    entityId: v.optional(v.string()),
    memoryType: v.union(
      v.literal('fact'),
      v.literal('preference'),
      v.literal('observation'),
      v.literal('reminder'),
    ),
    content: v.string(),
    // pgvector vector(1536). Optional because the PG column is nullable and the
    // match_* RPCs explicitly skip rows WHERE embedding IS NULL. A row may exist
    // without an embedding (e.g. a write that pre-dates embedding, or a non-
    // semantic scratch row); the vector index simply won't return it.
    embedding: v.optional(v.array(v.float64())),
    importance: v.number(), // 0..1 ranking score (double precision), default 0.5
    expiresAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    taskId: v.optional(v.string()),
    sourceRunId: v.optional(v.string()),
    sourceToolName: v.optional(v.string()),
    sourceConversationId: v.optional(v.string()),
  })
    // DELETE /api/agent/memory/[id] resolves a row by id (+ spaceId guard).
    .index('by_app_id', ['id'])
    // The user-facing memory list + insights + per-contact/deal panels filter by
    // (spaceId, entityType, entityId) and sort by importance/createdAt. PG had
    // AgentMemory_spaceId_entityId_idx = (spaceId, entityId); the richer
    // composite below serves every read (list, insights, contact/deal/brief).
    .index('by_space_entity', ['spaceId', 'entityType', 'entityId', 'createdAt'])
    // Vector recall (match_agent_memory). filterFields mirror the RPC's WHERE:
    // spaceId always; memoryType/entityType/entityId applied only when the
    // caller passes a filter (conditional .eq in the action). Convex caps
    // filterFields at 16 — we use 4. dimensions == EMBED_DIMS (1536).
    .vectorIndex('by_embedding', {
      vectorField: 'embedding',
      dimensions: 1536,
      filterFields: ['spaceId', 'memoryType', 'entityType', 'entityId'],
    }),

  // Was: "DocumentEmbedding" (TEXT id NOT NULL — PK, NO uuid default: the caller
  // supplies a stable composite id like `contact_<uuid>`/`deal_<uuid>`, spaceId,
  // entityType NOT NULL, entityId NOT NULL, content, embedding vector(1536)
  // nullable, tsv tsvector GENERATED — see below). PK(id) + upsert onConflict
  // 'id' => one row per composite id; the upsert mutation reads-by-id then
  // inserts-or-patches to preserve that.
  //
  // tsv (the Postgres GENERATED tsvector used by match_documents_hybrid's BM25
  // leg) has NO Convex equivalent — Convex has no tsvector / generated columns.
  // We DROP the column and reimplement the keyword leg in TS over `content`
  // (see documentEmbedding.ts searchHybrid). This is the biggest fidelity gap in
  // the domain and is flagged in the report.
  DocumentEmbedding: defineTable({
    id: v.string(),
    spaceId: v.string(),
    entityType: v.string(), // NOT a fixed enum in PG; callers pass 'contact'|'deal'
    entityId: v.string(),
    content: v.string(),
    embedding: v.optional(v.array(v.float64())), // vector(1536), nullable
  })
    // upsertVector / deleteVector resolve a row by its composite id
    // (deleteVector also guards on spaceId). PG PK(id).
    .index('by_app_id', ['id'])
    // Non-vector scans for a space's docs (idx_doc_embedding_space = spaceId).
    // Also the candidate-set scope when the hybrid keyword leg runs in TS.
    .index('by_space', ['spaceId'])
    // Vector retrieval (match_documents / match_documents_hybrid). The only RPC
    // filter is spaceId; entity columns are returned, never filtered. dimensions
    // == EMBED_DIMS (1536).
    .vectorIndex('by_embedding', {
      vectorField: 'embedding',
      dimensions: 1536,
      filterFields: ['spaceId'],
    }),
};
