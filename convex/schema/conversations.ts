import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Conversations domain — the chat-thread model that backs every Cola surface,
 * plus the client-portal message thread and the versioned agent-output store.
 * See convex/CONVENTIONS.md for the Postgres -> Convex translation rules every
 * table here follows (string `id`, ISO timestamps, CHECK enums -> v.union of
 * v.literal, nullable -> v.optional, jsonb -> v.any, integer counts -> v.number,
 * bool -> v.boolean).
 *
 * Seven tables, three surfaces:
 *
 *   SELLER CHAT (keyed by spaceId)
 *     - Conversation — a seller's Cola thread on /s/[slug]/cola.
 *     - Message      — a turn in a Conversation (user|assistant), ordered by
 *                      createdAt. `blocks` (jsonb) is the rich transcript; legacy
 *                      `content` is the plain-text fallback. conversationId is
 *                      NULLABLE in PG (orphan messages predate threading).
 *
 *   MANAGER CHAT (keyed by companyId — STRUCTURALLY SEPARATE TABLES)
 *     - ManagerConversation — a company's Cola thread on /manager.
 *     - ManagerMessage      — a turn in a ManagerConversation. The manager
 *                             analogue of Message, isolated by living in its OWN
 *                             table keyed by companyId, NOT spaceId. A seller
 *                             surface cannot read a manager row because the rows
 *                             are not even in the same table.
 *
 *   CLIENT PORTAL
 *     - ClientMessage — the seller<->client thread for one Contact. senderType
 *                       CHECK ('client'|'seller'); readAt marks read.
 *
 *   AGENT ARTIFACTS (versioned content)
 *     - Artifact        — a versioned output surface (draft email/sms, report,
 *                         etc.). artifactType + status are CHECK enums.
 *                         currentVersionId points at the live ArtifactVersion.
 *     - ArtifactVersion — an immutable revision of an Artifact, ordered by
 *                         versionNumber. content + contentHash are NOT NULL in
 *                         PG; spaceId is NOT NULL and mirrors the parent
 *                         Artifact's spaceId. The create/version mutations derive
 *                         contentHash and inherit spaceId (the old routes never
 *                         passed either — the data layer fills them so the row is
 *                         valid; see convex/conversations/artifacts.ts).
 *
 * Postgres ON DELETE CASCADE the code relies on (no native Convex equivalent) is
 * re-implemented as explicit cascade deletes in the delete mutations:
 *   - ManagerConversation delete -> its ManagerMessage rows (the seller
 *     Conversation delete route does NOT cascade Message rows today — it issues a
 *     bare row delete — so deleteConversation here mirrors that single-row delete
 *     and leaves Message rows, matching current behavior exactly).
 *   - Artifact delete -> its ArtifactVersion rows (no call site deletes an
 *     Artifact today; the cron retention RPC handles aging — out of this domain).
 */
export const conversationsTables = {
  // Was: "Conversation" (TEXT id, spaceId, title default 'New conversation',
  // createdAt, updatedAt). Seller Cola thread.
  Conversation: defineTable({
    id: v.string(),
    spaceId: v.string(),
    title: v.string(), // default 'New conversation' applied by the writer
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // resolveConversation / rename / delete / message-list guard look a
    // conversation up by its string id.
    .index('by_app_id', ['id'])
    // The seller list (/api/ai/conversations GET, /s/[slug]/cola page) filters by
    // spaceId and orders by updatedAt DESC. The reserved-title exclusion is
    // applied in memory by the caller (lib/chat/conversation-access) — Convex
    // has no NOT LIKE, so we return the space's rows and the lib filters.
    .index('by_space_updated', ['spaceId', 'updatedAt']),

  // Was: "Message" (TEXT id, spaceId, conversationId NULLABLE, role, content
  // NOT NULL, createdAt, blocks jsonb NULLABLE). A seller chat turn.
  Message: defineTable({
    id: v.string(),
    spaceId: v.string(),
    conversationId: v.optional(v.string()), // NULLABLE in PG (orphan/pre-threading rows)
    role: v.string(), // 'user' | 'assistant' (no PG CHECK; lib filters on these two)
    content: v.string(), // NOT NULL; assistant tool-only turns store a placeholder
    blocks: v.optional(v.any()), // jsonb array of MessageBlock; absent/NULL = render content
    createdAt: v.string(), // ISO-8601
  })
    // Every message read filters by conversationId and orders by createdAt ASC
    // (message list, page hydrate) or DESC (history load + per-conversation
    // preview). The compound index carries the order after the equality.
    .index('by_conversation_created', ['conversationId', 'createdAt'])
    // loadHistory filters (spaceId, conversationId); spaceId-first lets that run
    // on the index while still ordering by createdAt.
    .index('by_space_conversation_created', ['spaceId', 'conversationId', 'createdAt']),

  // Was: "ManagerConversation" (TEXT id, companyId, title default
  // 'New conversation', createdAt, updatedAt). Company Cola thread — separate
  // table from Conversation, keyed by companyId.
  ManagerConversation: defineTable({
    id: v.string(),
    companyId: v.string(),
    title: v.string(), // default 'New conversation'
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // resolveConversation / rename / delete / message-list guard key by id.
    .index('by_app_id', ['id'])
    // The manager list (/api/ai/manager-conversations GET, /manager page) filters
    // by companyId, orders by updatedAt DESC, limit 50.
    .index('by_company_updated', ['companyId', 'updatedAt']),

  // Was: "ManagerMessage" (TEXT id, companyId, conversationId NOT NULL, role,
  // content default '', blocks jsonb NULLABLE, createdAt). A manager chat turn.
  ManagerMessage: defineTable({
    id: v.string(),
    companyId: v.string(),
    conversationId: v.string(), // NOT NULL in PG (manager messages always belong to a thread)
    role: v.string(), // 'user' | 'assistant'
    content: v.string(), // default '' in PG; tool-only turns store a placeholder
    blocks: v.optional(v.any()), // jsonb array of MessageBlock
    createdAt: v.string(), // ISO-8601
  })
    // Every manager message read filters by conversationId and orders by
    // createdAt (ASC for the list, DESC for history + preview).
    .index('by_conversation_created', ['conversationId', 'createdAt']),

  // Was: "ClientMessage" (TEXT id, contactId, spaceId, senderType CHECK
  // ('client'|'seller'), body NOT NULL, readAt NULLABLE, createdAt). The
  // seller<->client portal thread for one Contact.
  ClientMessage: defineTable({
    id: v.string(),
    contactId: v.string(),
    spaceId: v.string(),
    senderType: v.union(v.literal('client'), v.literal('seller')), // CHECK enum
    body: v.string(),
    readAt: v.optional(v.string()), // ISO-8601; absent = unread
    createdAt: v.string(), // ISO-8601
  })
    // Both portal endpoints read a contact's thread ordered by createdAt ASC, and
    // mark-read patches by (contactId, senderType, readAt IS NULL). contactId-
    // first index serves the list; the senderType/readAt filter is applied in
    // memory in the mark-read mutation.
    .index('by_contact_created', ['contactId', 'createdAt']),

  // Was: "Artifact" (TEXT id, spaceId, taskId NULLABLE, stepId NULLABLE,
  // artifactType CHECK, title, contentType default 'text/plain', status default
  // 'draft' CHECK, currentVersionId NULLABLE, createdAt, updatedAt). A versioned
  // agent-output surface.
  Artifact: defineTable({
    id: v.string(),
    spaceId: v.string(),
    taskId: v.optional(v.string()),
    stepId: v.optional(v.string()),
    artifactType: v.union(
      v.literal('draft_email'),
      v.literal('draft_sms'),
      v.literal('deal_update'),
      v.literal('contact_update'),
      v.literal('demo_booking'),
      v.literal('goal_plan'),
      v.literal('report'),
      v.literal('raw_output'),
    ),
    title: v.string(),
    contentType: v.string(), // default 'text/plain'
    status: v.union(
      v.literal('draft'),
      v.literal('approved'),
      v.literal('rejected'),
      v.literal('superseded'),
    ),
    currentVersionId: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // get / version / download look an artifact up by id.
    .index('by_app_id', ['id'])
    // The list endpoint filters by spaceId, orders by createdAt DESC, limit 50,
    // with optional taskId / artifactType filters applied in memory (PG had
    // Artifact_spaceId_taskId_idx + Artifact_spaceId_status_idx).
    .index('by_space_created', ['spaceId', 'createdAt']),

  // Was: "ArtifactVersion" (TEXT id, artifactId, spaceId NOT NULL,
  // versionNumber int default 1, content NOT NULL, contentHash NOT NULL,
  // metadata jsonb default '{}', createdByAgent default 'cola', createdAt). An
  // immutable revision of an Artifact.
  //
  // contentHash + spaceId are NOT NULL in PG with no fill from the old routes —
  // the create/version mutations derive contentHash from content and inherit
  // spaceId from the parent Artifact, so every inserted row is valid.
  ArtifactVersion: defineTable({
    id: v.string(),
    artifactId: v.string(),
    spaceId: v.string(), // inherited from the parent Artifact
    versionNumber: v.number(), // integer, default 1
    content: v.string(),
    contentHash: v.string(), // sha-256 hex of content (derived in the mutation)
    metadata: v.any(), // jsonb; default {}
    createdByAgent: v.string(), // default 'cola'
    createdAt: v.string(), // ISO-8601
  })
    // Every version read filters by artifactId and orders by versionNumber (ASC
    // to list, DESC to find the max for the next version). The download route
    // also filters by versionNumber / by id within an artifact.
    .index('by_artifact_version', ['artifactId', 'versionNumber']),
};
