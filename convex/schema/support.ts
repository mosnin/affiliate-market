import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Support & messaging domain tables. See convex/CONVENTIONS.md for the
 * Postgres -> Convex translation rules every table here follows (string `id`,
 * ISO timestamps, CHECK enums -> v.union of v.literal, nullable -> v.optional,
 * integer counts -> v.number, bool -> v.boolean).
 *
 * Four tables:
 *   - SupportTicket   — seller-submitted help request, admin-triaged.
 *   - MessageTemplate — a space's personal SMS/email/note template (can be a
 *                       copy pushed down from a CompanyTemplate via publish).
 *   - EmailBroadcast  — a logged admin broadcast send (insert-only audit row).
 *   - CallLog         — one click-to-call leg, filled in by Telnyx webhooks.
 *
 * No table in this domain carries a Postgres uniqueness constraint, so there are
 * no read-then-insert invariants to re-implement here (unlike credits/calendar).
 * The PG foreign keys (Space ON DELETE SET NULL / CASCADE) are not enforced in
 * Convex; nothing in these mutations relies on cascade behavior.
 */
export const supportTables = {
  // Was: "SupportTicket" (TEXT id, spaceId nullable [FK ON DELETE SET NULL],
  // userId, email, name nullable, subject, message, category/status/priority
  // CHECK enums w/ defaults 'other'/'open'/'normal', adminNote nullable,
  // createdAt, updatedAt).
  SupportTicket: defineTable({
    id: v.string(),
    spaceId: v.optional(v.string()), // nullable in PG (FK SET NULL)
    userId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    subject: v.string(),
    message: v.string(),
    category: v.union(
      v.literal('bug'),
      v.literal('question'),
      v.literal('billing'),
      v.literal('feature'),
      v.literal('other'),
    ),
    status: v.union(
      v.literal('open'),
      v.literal('in_progress'),
      v.literal('resolved'),
      v.literal('closed'),
    ),
    priority: v.union(v.literal('low'), v.literal('normal'), v.literal('high')),
    adminNote: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // Admin PATCH and the per-row triage read look a ticket up by its string id.
    .index('by_app_id', ['id'])
    // Seller GET lists "my tickets" newest-first: filter userId, order createdAt
    // desc. PG had (userId, createdAt DESC) — compound so the order rides the index.
    .index('by_user_created', ['userId', 'createdAt'])
    // Admin list filters by ?status= (PG SupportTicket_status_idx).
    .index('by_status', ['status']),

  // Was: "MessageTemplate" (TEXT id, spaceId [FK CASCADE], name, channel CHECK
  // 'sms'|'email'|'note', subject nullable, body, createdAt, updatedAt,
  // sourceTemplateId nullable [FK CompanyTemplate SET NULL], sourceVersion
  // nullable). A row with sourceTemplateId set is a copy pushed from a
  // CompanyTemplate; sourceVersion NULL means the seller locally edited it
  // (publish must NOT stomp those).
  MessageTemplate: defineTable({
    id: v.string(),
    spaceId: v.string(),
    name: v.string(),
    channel: v.union(v.literal('sms'), v.literal('email'), v.literal('note')),
    subject: v.optional(v.string()),
    body: v.string(),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    sourceTemplateId: v.optional(v.string()),
    sourceVersion: v.optional(v.number()),
  })
    // PATCH/DELETE/publish-update look a template up by its string id.
    .index('by_app_id', ['id'])
    // GET lists a space's templates ordered by updatedAt desc
    // (PG idx_message_template_space_updated = (spaceId, updatedAt DESC)).
    .index('by_space_updated', ['spaceId', 'updatedAt'])
    // Publish fan-out finds existing copies of a source across target spaces
    // (PG idx_message_template_source). Compound with spaceId so the publish
    // query that scopes "this source within these spaces" runs on one index.
    .index('by_source_space', ['sourceTemplateId', 'spaceId']),

  // Was: "EmailBroadcast" (TEXT id [no default — caller supplies it], subject,
  // body, segment, recipientCount/sentCount/failedCount integers default 0,
  // sentBy nullable, createdAt). Insert-only audit log of a broadcast send.
  EmailBroadcast: defineTable({
    id: v.string(),
    subject: v.string(),
    body: v.string(),
    segment: v.string(),
    recipientCount: v.number(),
    sentCount: v.number(),
    failedCount: v.number(),
    sentBy: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // The admin broadcast page lists past sends newest-first (PG
    // EmailBroadcast_createdAt_idx). Nothing reads it by id.
    .index('by_created', ['createdAt']),

  // Was: "CallLog" (TEXT id, spaceId [FK CASCADE], contactId nullable, direction
  // CHECK 'outbound'|'inbound' default 'outbound', fromNumber, toNumber,
  // telnyxCallId nullable, status CHECK enum default 'initiated', recordingUrl/
  // transcript/summary nullable, durationSec integer nullable, createdAt,
  // updatedAt).
  CallLog: defineTable({
    id: v.string(),
    spaceId: v.string(),
    contactId: v.optional(v.string()),
    direction: v.union(v.literal('outbound'), v.literal('inbound')),
    fromNumber: v.string(),
    toNumber: v.string(),
    telnyxCallId: v.optional(v.string()),
    status: v.union(
      v.literal('initiated'),
      v.literal('ringing'),
      v.literal('answered'),
      v.literal('completed'),
      v.literal('failed'),
      v.literal('no_answer'),
    ),
    recordingUrl: v.optional(v.string()),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    durationSec: v.optional(v.number()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // GET /api/calls/[id] and the place-call follow-up updates read/patch by id.
    .index('by_app_id', ['id'])
    // GET list = a space's calls newest-first (PG CallLog_spaceId_createdAt_idx).
    .index('by_space_created', ['spaceId', 'createdAt'])
    // The Telnyx webhook correlates events back to a row by telnyxCallId
    // (PG CallLog_telnyxCallId_idx). Every lifecycle update runs on this.
    .index('by_telnyx', ['telnyxCallId'])
    // PG CallLog_contactId_createdAt_idx — a contact's call history. No call
    // site reads this today, but it's the natural lookup and mirrors PG; cheap
    // to define now so a "calls for this contact" view needn't touch the schema.
    .index('by_contact_created', ['contactId', 'createdAt']),
};
