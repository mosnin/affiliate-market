import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Infra domain tables — the platform's plumbing: stored files + chat
 * attachments, MCP API-key / OAuth-code auth, the audit log, telemetry,
 * the Inngest dead-letter queue, the seller↔Stripe webhook bridge, and
 * per-turn chat token/cost usage.
 *
 * See convex/CONVENTIONS.md for the Postgres -> Convex translation rules every
 * table here follows (string `id`; ISO-8601 timestamps as v.string(); CHECK
 * enums -> v.union of v.literal; nullable -> v.optional; jsonb -> v.any;
 * integer counts/cents -> v.number NEVER float; bool -> v.boolean;
 * text[] -> v.array(v.string())).
 *
 * SECURITY: McpApiKey + McpAuthCode back API-key / OAuth auth. The lookup
 * indexes mirror the EXACT Postgres lookup keys the auth paths use
 * (McpApiKey by keyHash and by clientId; McpAuthCode by code) so the hash/
 * code matching is byte-for-byte unchanged. Expiry, PKCE, constant-time hash
 * comparison and JWT signing all stay in the route/lib (pure crypto) — these
 * tables only persist the values.
 *
 * Postgres UNIQUE invariants that encode real behavior (no native Convex
 * equivalent) are re-implemented as read-then-insert/patch inside the
 * mutations (serializable within one mutation). Noted per table:
 *   - File.storageKey UNIQUE (File_storageKey_key).
 *   - McpApiKey.clientId UNIQUE (McpApiKey_clientId_key).
 *   - McpAuthCode.code UNIQUE (McpAuthCode_code_key).
 *   - StripeBridge.spaceId UNIQUE (StripeBridge_spaceId_key): one bridge per
 *     space — getOrCreate reads by spaceId then inserts.
 *
 * CROSS-DOMAIN TRIGGER (flagged, NOT reimplemented here): the old Postgres
 * schema fires `charge_credits_for_chat_usage` AFTER INSERT ON "ChatUsage",
 * draining the space's CreditLot rows (the CREDITS domain, owned by another
 * agent). Convex has no trigger; folding a credits write into this domain's
 * insert mutation would violate the parallel-split rule (CONVENTIONS: keep
 * cross-domain orchestration in lib, swap only your own tables). The integrator
 * must re-attach that charge as a lib→lib call around recordChatUsage. See the
 * note on `insert` in convex/infra/chatUsage.ts.
 */
export const infraTables = {
  // Was: "File" (id default gen_random_uuid()::text, spaceId, userId, storageKey
  // (UNIQUE), name, mimeType, category, sizeBytes BIGINT (>=0), isPublic default
  // false, createdAt). storageKey global UNIQUE. In-app editor "documents" are
  // just File rows with mimeType='text/markdown' — no separate table.
  File: defineTable({
    id: v.string(),
    spaceId: v.string(),
    userId: v.string(),
    storageKey: v.string(),
    name: v.string(),
    mimeType: v.string(),
    category: v.string(),
    sizeBytes: v.number(), // BIGINT byte count (>=0)
    isPublic: v.boolean(), // default false
    createdAt: v.string(), // ISO-8601
  })
    // Per-row reads/updates/deletes key by id (+ spaceId scope): files/[id]
    // GET+DELETE, documents/[id] loadDoc (also filters mimeType), studio
    // recent-job, read_file, attach_file_to_product. File_spaceId_createdAt_idx
    // is the seller-list path; by_app_id serves the id lookups.
    .index('by_app_id', ['id'])
    // GET /api/files list + POST quota scan + files page count/size scan filter
    // by spaceId, newest-first (File_spaceId_createdAt_idx = (spaceId, createdAt
    // DESC)). Also backs documents list (then filtered to text/markdown in mem)
    // and the account-deletion-adjacent space scans.
    .index('by_space_created', ['spaceId', 'createdAt'])
    // list_files tool + GET /api/files optional category filter
    // (File_spaceId_category_idx = (spaceId, category, createdAt DESC)).
    .index('by_space_category_created', ['spaceId', 'category', 'createdAt'])
    // storage-gc cron resolves referenced keys via `.in('storageKey', [...])`
    // (files + studio prefixes). UNIQUE(storageKey) — also the uniqueness read.
    .index('by_storage_key', ['storageKey']),

  // Was: "Attachment" (id, spaceId, userId nullable, conversationId nullable,
  // filename, mimeType, sizeBytes int, storagePath, publicUrl, extractedText
  // nullable, extractionStatus default 'pending' CHECK enum, createdAt). Chat
  // upload rows; no FK to Space (swept explicitly on account deletion).
  Attachment: defineTable({
    id: v.string(),
    spaceId: v.string(),
    userId: v.optional(v.string()),
    conversationId: v.optional(v.string()),
    filename: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(), // integer byte count
    storagePath: v.string(),
    publicUrl: v.string(), // new rows write '' (readers re-sign from storagePath)
    extractedText: v.optional(v.string()),
    extractionStatus: v.union(
      v.literal('pending'),
      v.literal('skipped'),
      v.literal('done'),
      v.literal('failed'),
    ),
    createdAt: v.string(), // ISO-8601
  })
    // read_attachment + DELETE /api/ai/attachments + ai/task hydrate look an
    // attachment up by id (the route checks spaceId in mem). Also the batch
    // `.in('id', [...])` hydrate path. Attachment_spaceId_createdAt_idx backs the
    // space list; by_app_id serves the id lookups.
    .index('by_app_id', ['id'])
    // GET /api/files lists a space's chat attachments newest-first
    // (Attachment_spaceId_createdAt_idx = (spaceId, createdAt DESC)). Also the
    // account-deletion sweep filters by spaceId. (Attachment_conversationId_idx
    // existed but no current call site queries by conversationId — omitted.)
    .index('by_space_created', ['spaceId', 'createdAt']),

  // Was: "McpApiKey" (id, spaceId, name default 'Default', keyHash, keyPrefix,
  // lastUsedAt nullable, createdAt, clientId nullable (UNIQUE), clientSecretHash
  // nullable, expiresAt nullable). SECURITY: auth lookups are by keyHash (raw
  // Bearer key) and by clientId (OAuth client_credentials). Expiry is checked in
  // JS after the read (NULL expiresAt = legacy key, never expires).
  McpApiKey: defineTable({
    id: v.string(),
    spaceId: v.string(),
    name: v.string(), // default 'Default'
    keyHash: v.string(), // sha256 of the raw key
    keyPrefix: v.string(),
    lastUsedAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    clientId: v.optional(v.string()), // UNIQUE when present
    clientSecretHash: v.optional(v.string()),
    expiresAt: v.optional(v.string()),
  })
    // DELETE /api/mcp-keys[/id] verify-then-delete keys by id (+ spaceId scope)
    // (McpApiKey_pkey). by_app_id serves that ownership read + delete.
    .index('by_app_id', ['id'])
    // Bearer-key auth: lookup by keyHash + lastUsedAt patch by keyHash
    // (idx_mcp_api_key_hash). Exact-match — never a prefix.
    .index('by_key_hash', ['keyHash'])
    // OAuth client_credentials + authorize + consent-page lookups by clientId,
    // and lastUsedAt patch by clientId (idx_mcp_api_key_client_id; clientId is
    // also UNIQUE). Exact-match.
    .index('by_client_id', ['clientId'])
    // List/count a space's keys newest-first (idx_mcp_api_key_space). The list
    // sorts createdAt DESC in lib; the count just scans this index.
    .index('by_space', ['spaceId']),

  // Was: "McpAuthCode" (id, code (UNIQUE), clientId, spaceId, codeChallenge,
  // codeChallengeMethod default 'S256', redirectUri, expiresAt NOT NULL,
  // createdAt, stateNonce nullable, stateHash nullable). Short-lived (5 min),
  // single-use PKCE authorization codes. SECURITY: the only lookup + the
  // single-use delete are both by `code` (exact). Expiry/PKCE/redirect/state
  // checks happen in JS on the fetched row.
  McpAuthCode: defineTable({
    id: v.string(),
    code: v.string(), // UNIQUE
    clientId: v.string(),
    spaceId: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.string(), // default 'S256'
    redirectUri: v.string(),
    expiresAt: v.string(), // ISO-8601 (NOT NULL — now + 5 min)
    createdAt: v.string(), // ISO-8601
    stateNonce: v.optional(v.string()),
    stateHash: v.optional(v.string()),
  })
    // Token exchange reads the full row by code, then deletes by code at every
    // validation gate + on success (idx_mcp_auth_code = code; McpAuthCode_code_key
    // UNIQUE). by_code is the only access path — and backs the uniqueness read.
    .index('by_code', ['code']),

  // Was: "AuditLog" (id default gen_random_uuid()::text, clerkId nullable,
  // actorId nullable, ipAddress nullable, action, resource, resourceId nullable,
  // spaceId nullable, metadata jsonb nullable, createdAt). Append-mostly SOC-2
  // log: many inserts, filtered reads on the admin + manager activity pages.
  AuditLog: defineTable({
    id: v.string(),
    clerkId: v.optional(v.string()),
    actorId: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
    action: v.string(),
    resource: v.string(),
    resourceId: v.optional(v.string()),
    spaceId: v.optional(v.string()),
    metadata: v.optional(v.any()), // jsonb (nullable)
    createdAt: v.string(), // ISO-8601
  })
    // Manager activity slice A filters spaceId IN [...] + createdAt >= since
    // (+ optional action/clerkId/cursor), newest-first (audit_log_space_idx /
    // audit_resource_created_idx family). We index spaceId+createdAt; the IN,
    // action/clerkId, keyset-cursor and the two-query merge stay in lib (it
    // joins User/Space and dedupes — cross-table orchestration).
    // (No createdAt-only index: the admin page's unfiltered "newest 200" reads
    // the table ordered by the reserved _creationTime — insertion order tracks
    // createdAt for an append log — see auditLog.listRecent.)
    .index('by_space_created', ['spaceId', 'createdAt']),

  // Was: "TelemetryEvent" (id, spaceId nullable, userId nullable, event,
  // payload jsonb default {}, createdAt). Append-mostly first-value analytics.
  TelemetryEvent: defineTable({
    id: v.string(),
    spaceId: v.optional(v.string()),
    userId: v.optional(v.string()),
    event: v.string(),
    payload: v.any(), // jsonb (default {})
    createdAt: v.string(), // ISO-8601
  })
    // hasEmitted (count) + getFirstEmittedAt (earliest) filter (spaceId, event)
    // (TelemetryEvent_spaceId_event_idx). Also the account-deletion sweep
    // filters by spaceId — covered by the same index's prefix.
    // (TelemetryEvent_event_createdAt_idx (event, createdAt DESC) existed for a
    // global per-event scan; no current call site uses it — omitted.)
    .index('by_space_event', ['spaceId', 'event']),

  // Was: "DeadLetterEvent" (id, spaceId, eventType, eventPayload jsonb default
  // {}, errorMessage, errorStack nullable, attemptCount default 1, firstFailedAt,
  // lastFailedAt, resolvedAt nullable, resolvedBy nullable, resolutionNote
  // nullable, status default 'pending' CHECK enum, taskId nullable, createdAt).
  // Inngest DLQ: producer inserts on final failure; admin DLQ UI lists/reads/
  // patches.
  //
  // NOTE (preserved bug): the admin DLQ POST/PATCH routes reference columns
  // `payload`, `error`, and `retryCount` that DO NOT EXIST on this table (the
  // real columns are eventPayload, errorMessage, attemptCount). Those Supabase
  // writes/reads silently no-op today. The functions below expose BOTH the real
  // columns and these alias fields so the existing call-site contract is
  // preserved verbatim — see convex/infra/deadLetter.ts. Flagged for the
  // integrator to decide whether to fix the routes or keep the alias.
  DeadLetterEvent: defineTable({
    id: v.string(),
    spaceId: v.string(),
    eventType: v.string(),
    eventPayload: v.any(), // jsonb (default {})
    errorMessage: v.string(),
    errorStack: v.optional(v.string()),
    attemptCount: v.number(), // integer (default 1)
    firstFailedAt: v.string(), // ISO-8601 (PG default now())
    lastFailedAt: v.string(), // ISO-8601 (PG default now())
    resolvedAt: v.optional(v.string()),
    resolvedBy: v.optional(v.string()),
    resolutionNote: v.optional(v.string()),
    status: v.union(
      v.literal('pending'),
      v.literal('retrying'),
      v.literal('resolved'),
      v.literal('abandoned'),
    ),
    taskId: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    // Alias columns the admin routes write/read but that aren't real PG columns
    // (see NOTE above). Optional so real producer rows omit them; the admin
    // create path populates them so its read-back round-trips unchanged.
    payload: v.optional(v.any()),
    error: v.optional(v.string()),
    retryCount: v.optional(v.number()),
  })
    // GET single + PATCH fetch-then-update key by id (DeadLetterEvent_pkey).
    .index('by_app_id', ['id'])
    // GET /api/admin/dlq lists newest-first with optional spaceId and/or status
    // filters (DeadLetterEvent_spaceId_status_idx + the createdAt sort). We index
    // by status (the common filter) and by space; the list applies the other
    // filter + sort in lib over the small result. createdAt sort uses insertion
    // order (_creationTime) for the unfiltered case.
    .index('by_status', ['status'])
    .index('by_space', ['spaceId']),

  // Was: "StripeBridge" (id, spaceId (UNIQUE), webhookSecretEnc nullable,
  // lastEventAt nullable, createdAt). The seller↔Stripe webhook bridge: one row
  // per space. (No stripeAccountId column — attribution is by webhook signature
  // + event metadata, handled in lib/affiliates/stripe-bridge.ts.)
  StripeBridge: defineTable({
    id: v.string(),
    spaceId: v.string(), // UNIQUE — one bridge per space
    webhookSecretEnc: v.optional(v.string()),
    lastEventAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // getBridgeById + setBridgeSecret + the lastEventAt patch key by id
    // (StripeBridge_pkey). The webhook route resolves the bridge by id.
    .index('by_app_id', ['id'])
    // getBridgeForSpace + getOrCreateBridge read by spaceId (UNIQUE) — also
    // backs the one-per-space read-then-insert in the getOrCreate mutation.
    .index('by_space', ['spaceId']),

  // Was: "ChatUsage" (id, spaceId, userId nullable, conversationId nullable,
  // model, promptTokens default 0, completionTokens default 0, costUsd
  // numeric(10,6) default 0, runtime default 'modal', createdAt, cachedTokens
  // default 0, provider default 'unknown', route default 'agent'). Per-turn LLM
  // token/cost telemetry. costUsd is a fractional USD amount (NOT integer cents)
  // — numeric(10,6) -> v.number; the cost math lives in lib/usage and is mirrored
  // verbatim, never recomputed here.
  ChatUsage: defineTable({
    id: v.string(),
    spaceId: v.string(),
    userId: v.optional(v.string()),
    conversationId: v.optional(v.string()),
    model: v.string(),
    promptTokens: v.number(), // integer (>=0, default 0)
    completionTokens: v.number(), // integer (>=0, default 0)
    costUsd: v.number(), // numeric(10,6) USD — fractional dollars, not cents
    runtime: v.string(), // default 'modal'
    createdAt: v.string(), // ISO-8601
    cachedTokens: v.number(), // integer (>=0, default 0)
    provider: v.string(), // default 'unknown'
    route: v.string(), // default 'agent'
  })
    // getTodayTokenUsage + GET /api/agent/usage (7d) filter (spaceId, createdAt
    // >= window) (ChatUsage_spaceId_createdAt_idx = (spaceId, createdAt DESC)).
    // manager/usage uses spaceId IN [...] over the same shape (IN expanded in
    // lib). The measurement script scans by createdAt only (cron-style; reads
    // every space) — that's a full scan in PG too (no createdAt-only index), so
    // chatUsage.allSince collects + filters by createdAt.
    .index('by_space_created', ['spaceId', 'createdAt']),
};
