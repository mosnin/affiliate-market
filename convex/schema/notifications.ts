import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Notifications domain tables. See convex/CONVENTIONS.md for the Postgres ->
 * Convex translation rules every table here follows (string `id`, ISO
 * timestamps, CHECK enums -> v.union of v.literal, nullable -> v.optional,
 * jsonb -> v.any, integer counts -> v.number, bool -> v.boolean).
 *
 * Four tables:
 *   - ManagerNotification   — in-app bell items for a company's manager.
 *   - PushSubscription      — one browser web-push endpoint per device/space.
 *   - Announcement          — platform-wide banner (admin-authored, segmented).
 *   - AnnouncementDismissal — "this user dismissed this announcement" (one per pair).
 *
 * Postgres invariants with no native Convex equivalent, re-implemented as
 * read-then-insert inside a (serializable) mutation:
 *   - PushSubscription_endpoint_key: UNIQUE (endpoint) -> re-subscribing the same
 *     browser upserts in place instead of minting a duplicate row.
 *   - AnnouncementDismissal_announcementId_userId_key: UNIQUE (announcementId,
 *     userId) -> a repeat dismiss is a no-op.
 *
 * The PG ON DELETE CASCADE on AnnouncementDismissal.announcementId (and
 * ManagerNotification.companyId / PushSubscription.spaceId) is NOT re-created
 * here: nothing in the app deletes a Company or Space row through Convex yet
 * (those tables aren't migrated), and announcement deletes today leave the
 * dismissal rows orphaned harmlessly (the GET only ever joins from live
 * announcements). If/when Announcement delete needs to cascade, the delete
 * mutation should also clear matching dismissals — noted on `remove` below.
 */
export const notificationsTables = {
  // Was: "ManagerNotification" (TEXT id, companyId, type, title, body nullable,
  // metadata jsonb nullable, read bool default false, createdAt). `type` has no
  // PG CHECK — it's a free text column the app constrains to a TS union — so it
  // stays v.string() here (translate CHECK enums to v.union; absent CHECK = no
  // union).
  ManagerNotification: defineTable({
    id: v.string(),
    companyId: v.string(),
    type: v.string(), // app-level union (member_joined | deal_won | ...), no PG CHECK
    title: v.string(),
    body: v.optional(v.string()),
    metadata: v.optional(v.any()), // jsonb; e.g. { kind: 'lead_sla_breach', ... }
    read: v.boolean(),
    createdAt: v.string(), // ISO-8601
  })
    // GET lists a company's notifications ordered by createdAt desc (limit 20),
    // and the brief page counts companyId + createdAt>=todayStart (type/metadata
    // filtered after the index). Was idx_manager_notif_company (companyId,
    // createdAt DESC).
    .index('by_company', ['companyId', 'createdAt'])
    // PATCH marks all of a company's UNREAD rows read — scan companyId+read=false.
    // Was the partial idx_manager_notif_unread (companyId, read) WHERE read=false.
    .index('by_company_read', ['companyId', 'read']),

  // Was: "PushSubscription" (TEXT id, spaceId, userId nullable, endpoint, p256dh,
  // auth, userAgent nullable, createdAt). UNIQUE(endpoint) preserved via the
  // by_endpoint index + read-then-insert in the upsert mutation.
  PushSubscription: defineTable({
    id: v.string(),
    spaceId: v.string(),
    userId: v.optional(v.string()),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // sendPushToSpace loads every subscription for a space. Was PushSubscription_spaceId_idx.
    .index('by_space', ['spaceId'])
    // upsert dedup (UNIQUE endpoint) + delete-by-endpoint both look up by endpoint.
    .index('by_endpoint', ['endpoint'])
    // Dead-subscription pruning deletes by the row's string id.
    .index('by_app_id', ['id']),

  // Was: "Announcement" (TEXT id, message, title nullable, severity CHECK enum
  // default 'info', targetSegment CHECK enum default 'all', linkUrl nullable,
  // linkLabel nullable, dismissible bool default true, active bool default true,
  // startsAt nullable, endsAt nullable, createdBy nullable, createdAt, updatedAt).
  Announcement: defineTable({
    id: v.string(),
    message: v.string(),
    title: v.optional(v.string()),
    severity: v.union(v.literal('info'), v.literal('warning'), v.literal('critical')), // CHECK enum
    targetSegment: v.union(
      v.literal('all'),
      v.literal('trial'),
      v.literal('active'),
      v.literal('past_due'),
      v.literal('admin'),
    ), // CHECK enum
    linkUrl: v.optional(v.string()),
    linkLabel: v.optional(v.string()),
    dismissible: v.boolean(),
    active: v.boolean(),
    startsAt: v.optional(v.string()), // ISO-8601; absent = no start bound
    endsAt: v.optional(v.string()), // ISO-8601; absent = no end bound
    createdBy: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // platform GET filters active=true (segment + nullable time-window can't be
    // index equality — applied in the handler after the index). Was the leading
    // column of Announcement_active_range_idx (active, startsAt, endsAt).
    .index('by_active', ['active'])
    // dismiss-verify, admin PATCH, and admin DELETE all look up by string id.
    .index('by_app_id', ['id']),

  // Was: "AnnouncementDismissal" (TEXT id, announcementId, userId, dismissedAt
  // default now()). UNIQUE(announcementId, userId) preserved via
  // by_announcement_user + read-then-insert in the dismiss mutation.
  AnnouncementDismissal: defineTable({
    id: v.string(),
    announcementId: v.string(),
    userId: v.string(),
    dismissedAt: v.string(), // ISO-8601 (was TIMESTAMPTZ default now())
  })
    // dismiss reads (announcementId, userId) to enforce one-per-pair. Was the
    // UNIQUE index AnnouncementDismissal_announcementId_userId_key.
    .index('by_announcement_user', ['announcementId', 'userId'])
    // platform GET loads all of a user's dismissals, then filters to the candidate
    // announcement ids in JS. Was AnnouncementDismissal_user_idx (userId).
    .index('by_user', ['userId']),
};
