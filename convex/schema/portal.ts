import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Portal domain tables — the client-facing surfaces of Cola: the seller's daily
 * briefing (Brief, BriefTipHistory), the public application form draft/analytics
 * (FormDraft, FormAnalyticsEvent), the shareable CMA report (CmaReport), the
 * buyer/applicant client portal auth (ClientUser, ClientAuthCode) and its
 * documents/info-requests (ClientDocument, ClientInfoRequest), the application
 * message/status thread (ApplicationMessage, ApplicationStatusUpdate), and
 * e-signature envelopes (SignatureRequest).
 *
 * See convex/CONVENTIONS.md for the Postgres -> Convex translation rules every
 * table follows: app's `gen_random_uuid()` PK kept as `id: v.string()` (the
 * `uuid`-typed PKs on ApplicationMessage/ApplicationStatusUpdate/FormDraft/
 * FormAnalyticsEvent are stored as the same string and minted with
 * crypto.randomUUID() — identical at rest); TIMESTAMPTZ -> ISO-8601 v.string();
 * `date` -> the 'YYYY-MM-DD' string callers compare lexically; CHECK enums ->
 * v.union of v.literal; nullable -> v.optional; jsonb -> v.any(); integer
 * counts/bytes -> v.number(); bool -> v.boolean().
 *
 * SECURITY-SENSITIVE (lib/client-auth.ts): ClientUser + ClientAuthCode back the
 * client-portal auth, fully separate from seller Clerk auth.
 *   - ClientUser.emailLower is UNIQUE (ClientUser_emailLower_key): exactly one
 *     account per normalized email. The create mutation re-implements it as a
 *     read-by-emailLower-then-insert inside one serializable mutation.
 *   - ClientAuthCode is a one-time, attempt-limited 6-digit code (hashed at
 *     rest). The match is `(emailLower, purpose)` + unconsumed + unexpired,
 *     newest-first — the exact same predicate PG used, served by
 *     ClientAuthCode_lookup_idx (emailLower, purpose, expiresAt). One-time-use +
 *     prior-code invalidation are preserved as read-then-patch in single
 *     mutations; the timing-safe hash compare itself stays in lib (pure crypto).
 *
 * Other Postgres uniqueness invariants re-implemented as read-then-insert/patch
 * inside one mutation (no native Convex equivalent):
 *   - idx_brief_space_date UNIQUE(spaceId, forDate): one Brief per space per
 *     local date — the cron/on-demand compose upserts on (spaceId, forDate).
 *   - CmaReport_shareToken_key UNIQUE(shareToken): the public /cma/[token] page
 *     resolves by it; the create mutation reads it before insert.
 *   - FormDraft_resumeToken_key UNIQUE(resumeToken): the resume-link page
 *     resolves by it.
 *
 * Brief delivery (lib/briefing/delivery.ts) relies on an atomic UPDATE-WHERE-NULL
 * claim on emailSentAt / smsSentAt to pick a single winner among concurrent cron
 * ticks. That CAS is preserved as a read-then-patch-if-still-null mutation.
 */
export const portalTables = {
  // Was: "Brief" (TEXT id, spaceId, forDate `date`, status default 'pending',
  // payload jsonb NOT NULL, createdAt, seenAt nullable, actedAt nullable,
  // cardMeta jsonb default '[]', cardTaps jsonb default '[]', emailSentAt
  // nullable, smsSentAt nullable, emailMessageId nullable, smsMessageId nullable,
  // briefDeliveryErrorCode nullable). `status` has no PG CHECK — the composer
  // sets 'pending' and the PATCH writes app-level statuses; kept v.string().
  Brief: defineTable({
    id: v.string(),
    spaceId: v.string(),
    forDate: v.string(), // 'YYYY-MM-DD' (was Postgres `date`) — the space's LOCAL date
    status: v.string(), // default 'pending' (no PG CHECK)
    payload: v.any(), // jsonb — the composed brief
    createdAt: v.string(), // ISO-8601
    seenAt: v.optional(v.string()),
    actedAt: v.optional(v.string()),
    cardMeta: v.any(), // jsonb array (default [])
    cardTaps: v.any(), // jsonb array (default [])
    emailSentAt: v.optional(v.string()), // delivery lock column (UPDATE-WHERE-NULL claim)
    smsSentAt: v.optional(v.string()), // delivery lock column (UPDATE-WHERE-NULL claim)
    emailMessageId: v.optional(v.string()),
    smsMessageId: v.optional(v.string()),
    briefDeliveryErrorCode: v.optional(v.string()),
  })
    // Delivery claims/patches a brief by id (lock CAS, messageId write, error
    // code). PATCH (seen/acted/taps) and the test-row delete also key by id.
    .index('by_app_id', ['id'])
    // The compose upsert + the agent/briefing reads look up the single brief for
    // (spaceId, forDate) — UNIQUE(spaceId, forDate). Backs the upsert read.
    // (idx_brief_space_date / idx_brief_space_date_created.)
    .index('by_space_date', ['spaceId', 'forDate'])
    // Delivery's "first-ever brief SMS?" count scans a space's briefs filtered to
    // smsSentAt != null. Analytics scans by createdAt window — those run on this
    // spaceId index (then filter in memory) or a full scan; no PG index on
    // createdAt alone existed for Brief, so the window reads collect + filter.
    .index('by_space', ['spaceId']),

  // Was: "BriefTipHistory" (TEXT id, spaceId, tipCategory, subjectId nullable,
  // firedAt default now(), outcome CHECK default 'shown'). outcome enum.
  BriefTipHistory: defineTable({
    id: v.string(),
    spaceId: v.string(),
    tipCategory: v.string(),
    subjectId: v.optional(v.string()), // nullable — null vs a value are distinct cool-down subjects
    firedAt: v.string(), // ISO-8601 (was TIMESTAMPTZ default now())
    outcome: v.union(v.literal('shown'), v.literal('acted'), v.literal('dismissed')),
  })
    // canFireTip reads the newest row for (spaceId, tipCategory [, subjectId])
    // ordered by firedAt desc, limit 1. idx_brieftip_space_cat_subject_fired =
    // (spaceId, tipCategory, subjectId, firedAt DESC). The null-subject branch
    // filters subjectId IS NULL in memory off this prefix.
    .index('by_space_cat_subject', ['spaceId', 'tipCategory', 'subjectId', 'firedAt']),

  // Was: "FormDraft" (UUID id, spaceId, email, resumeToken, answers jsonb default
  // '{}', currentStep int default 0, formConfigVersion int nullable, expiresAt
  // NOT NULL, completedAt nullable, createdAt, updatedAt). UUID PK -> v.string().
  FormDraft: defineTable({
    id: v.string(),
    spaceId: v.string(),
    email: v.string(), // the normalized (lowercased) email the lib stores/queries
    resumeToken: v.string(),
    answers: v.any(), // jsonb (default {})
    currentStep: v.number(), // integer (default 0)
    formConfigVersion: v.optional(v.number()), // integer, nullable
    expiresAt: v.string(), // ISO-8601 (NOT NULL)
    completedAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // Update of an existing draft keys by id.
    .index('by_app_id', ['id'])
    // The resume-link page resolves a draft by resumeToken (FormDraft_resumeToken_key
    // UNIQUE; idx_form_draft_resume_token). Also backs the token-uniqueness read.
    .index('by_resume_token', ['resumeToken'])
    // The "existing open draft for this (space, email)?" check filters
    // (spaceId, email) + completedAt IS NULL + expiresAt > now, newest-first.
    // idx_form_draft_space_email = (spaceId, email).
    .index('by_space_email', ['spaceId', 'email']),

  // Was: "FormAnalyticsEvent" (UUID id, spaceId, sessionId, formConfigVersion int
  // nullable, eventType CHECK, stepIndex int nullable, stepTitle nullable,
  // durationMs int nullable, metadata jsonb nullable, createdAt). UUID PK ->
  // v.string(). eventType enum.
  FormAnalyticsEvent: defineTable({
    id: v.string(),
    spaceId: v.string(),
    sessionId: v.string(),
    formConfigVersion: v.optional(v.number()), // integer, nullable
    eventType: v.union(
      v.literal('form_start'),
      v.literal('step_view'),
      v.literal('step_complete'),
      v.literal('form_submit'),
      v.literal('form_abandon'),
    ),
    stepIndex: v.optional(v.number()), // integer, nullable
    stepTitle: v.optional(v.string()),
    durationMs: v.optional(v.number()), // integer, nullable
    metadata: v.any(), // jsonb, nullable
    createdAt: v.string(), // ISO-8601
  })
    // The auth'd analytics read filters (spaceId, createdAt >= cutoff [,
    // formConfigVersion]) ordered by createdAt asc. idx_form_analytics_space_created_type
    // = (spaceId, createdAt DESC, eventType); we range on createdAt after the
    // spaceId equality. Inserts are append-only; no per-row read.
    .index('by_space_created', ['spaceId', 'createdAt']),

  // Was: "CmaReport" (TEXT id, spaceId, subjectAddress, subjectProductId nullable,
  // shareToken, title nullable, status CHECK default 'draft', payload jsonb
  // default '{}', createdAt, updatedAt). status enum.
  CmaReport: defineTable({
    id: v.string(),
    spaceId: v.string(),
    subjectAddress: v.string(),
    subjectProductId: v.optional(v.string()),
    shareToken: v.string(),
    title: v.optional(v.string()),
    status: v.union(v.literal('draft'), v.literal('published')),
    payload: v.any(), // jsonb (default {})
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // get/patch/delete one report key by (id, spaceId).
    .index('by_app_id', ['id'])
    // The public /cma/[token] page resolves by shareToken (CmaReport_shareToken_key
    // UNIQUE). Also backs the token-uniqueness read in the create mutation.
    .index('by_share_token', ['shareToken'])
    // The seller's report list filters spaceId, newest-first.
    // CmaReport_space_created_idx = (spaceId, createdAt DESC).
    .index('by_space_created', ['spaceId', 'createdAt']),

  // Was: "ClientUser" (TEXT id, email, emailLower, passwordHash, name nullable,
  // phone nullable, emailVerifiedAt nullable, createdAt, updatedAt). emailLower
  // is UNIQUE (ClientUser_emailLower_key) — one account per normalized email.
  ClientUser: defineTable({
    id: v.string(),
    email: v.string(),
    emailLower: v.string(),
    passwordHash: v.string(),
    name: v.optional(v.string()),
    phone: v.optional(v.string()),
    emailVerifiedAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // findClientById (the session resolver) keys by id.
    .index('by_app_id', ['id'])
    // findClientByEmail + verify/password updates key by emailLower (UNIQUE).
    // Backs the create mutation's uniqueness read-then-insert.
    .index('by_email_lower', ['emailLower']),

  // Was: "ClientAuthCode" (TEXT id, emailLower, codeHash, purpose CHECK, expiresAt
  // NOT NULL, consumedAt nullable, attempts int default 0, createdAt). purpose
  // enum. One-time, attempt-limited code; the hash compare stays in lib.
  ClientAuthCode: defineTable({
    id: v.string(),
    emailLower: v.string(),
    codeHash: v.string(),
    purpose: v.union(v.literal('verify'), v.literal('login'), v.literal('reset')),
    expiresAt: v.string(), // ISO-8601 (NOT NULL)
    consumedAt: v.optional(v.string()),
    attempts: v.number(), // integer (default 0)
    createdAt: v.string(), // ISO-8601
  })
    // consume/increment-attempts patch a specific candidate by id.
    .index('by_app_id', ['id'])
    // The candidate lookup + the prior-code invalidation both filter
    // (emailLower, purpose). ClientAuthCode_lookup_idx = (emailLower, purpose,
    // expiresAt); the unconsumed/unexpired/newest predicate filters in memory.
    .index('by_email_purpose', ['emailLower', 'purpose']),

  // Was: "ClientDocument" (TEXT id, contactId, spaceId, fileKey, fileName,
  // contentType nullable, sizeBytes int nullable, uploadedBy default 'client',
  // createdAt). uploadedBy has no PG CHECK -> v.string().
  ClientDocument: defineTable({
    id: v.string(),
    contactId: v.string(),
    spaceId: v.string(),
    fileKey: v.string(),
    fileName: v.string(),
    contentType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()), // integer, nullable
    uploadedBy: v.string(), // default 'client'
    createdAt: v.string(), // ISO-8601
  })
    // The single-doc download fetch keys by (id, contactId).
    .index('by_app_id', ['id'])
    // The document list filters contactId, newest-first.
    // ClientDocument_contact_idx = (contactId, createdAt).
    .index('by_contact_created', ['contactId', 'createdAt']),

  // Was: "ClientInfoRequest" (TEXT id, contactId, spaceId, message, status CHECK
  // default 'pending', response nullable, createdAt, fulfilledAt nullable).
  // status enum.
  ClientInfoRequest: defineTable({
    id: v.string(),
    contactId: v.string(),
    spaceId: v.string(),
    message: v.string(),
    status: v.union(v.literal('pending'), v.literal('fulfilled'), v.literal('dismissed')),
    response: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    fulfilledAt: v.optional(v.string()),
  })
    // The fulfil-request flow fetches + patches a specific request by id.
    .index('by_app_id', ['id'])
    // The portal list filters contactId (status != 'dismissed'), newest-first.
    // ClientInfoRequest_contact_idx = (contactId, status).
    .index('by_contact_created', ['contactId', 'createdAt']),

  // Was: "ApplicationMessage" (UUID id, contactId, spaceId, senderType CHECK,
  // content (<=2000 chars), readAt nullable, createdAt). UUID PK -> v.string().
  // senderType enum.
  ApplicationMessage: defineTable({
    id: v.string(),
    contactId: v.string(),
    spaceId: v.string(),
    senderType: v.union(v.literal('applicant'), v.literal('seller')),
    content: v.string(), // CHECK char_length <= 2000 (validated in the route)
    readAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // The thread read filters contactId, oldest-first; the read-receipt update
    // patches the unread subset by id. idx_app_message_contact = (contactId,
    // createdAt); idx_app_message_unread = (contactId, readAt) WHERE readAt NULL.
    .index('by_contact_created', ['contactId', 'createdAt']),

  // Was: "ApplicationStatusUpdate" (UUID id, contactId, spaceId, fromStatus
  // nullable, toStatus, note nullable, createdAt). UUID PK -> v.string().
  ApplicationStatusUpdate: defineTable({
    id: v.string(),
    contactId: v.string(),
    spaceId: v.string(),
    fromStatus: v.optional(v.string()),
    toStatus: v.string(),
    note: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // The status timeline read filters contactId, oldest-first.
    // idx_app_status_update_contact = (contactId, createdAt). Inserts are
    // append-only audit rows.
    .index('by_contact_created', ['contactId', 'createdAt']),

  // Was: "SignatureRequest" (TEXT id, spaceId, dealId nullable, documentId
  // nullable, envelopeId nullable, subject, signerEmail, signerName nullable,
  // status CHECK default 'created', signedDocumentUrl nullable, completedAt
  // nullable, createdAt, updatedAt, contactId nullable). status enum.
  SignatureRequest: defineTable({
    id: v.string(),
    spaceId: v.string(),
    dealId: v.optional(v.string()),
    documentId: v.optional(v.string()),
    envelopeId: v.optional(v.string()),
    subject: v.string(),
    signerEmail: v.string(),
    signerName: v.optional(v.string()),
    status: v.union(
      v.literal('created'),
      v.literal('sent'),
      v.literal('delivered'),
      v.literal('completed'),
      v.literal('declined'),
      v.literal('voided'),
    ),
    signedDocumentUrl: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    contactId: v.optional(v.string()),
  })
    // get/patch one request by (id, spaceId) — the esign status route + the
    // refresh-status update.
    .index('by_app_id', ['id'])
    // The deal page lists a deal's signature requests filtered (dealId, spaceId),
    // newest-first. SignatureRequest_dealId_idx = (dealId). spaceId filtered in
    // memory after the dealId equality.
    .index('by_deal_created', ['dealId', 'createdAt'])
    // The seller contact page lists a contact's signature requests filtered
    // (contactId, spaceId), newest-first. SignatureRequest_contactId_createdAt_idx
    // = (contactId, createdAt DESC). spaceId filtered in memory.
    .index('by_contact_created', ['contactId', 'createdAt']),
};
