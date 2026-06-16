import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Demos domain tables. See convex/CONVENTIONS.md for the Postgres -> Convex
 * translation rules every table here follows (string `id`, ISO timestamps,
 * CHECK enums -> v.union of v.literal, nullable -> v.optional, integer[] ->
 * v.array(v.number()), integer/counts -> v.number, bool -> v.boolean).
 *
 * Five tables:
 *   - Demo                    — a booked product demo (guest, time window,
 *                               status lifecycle, manage token, GCal mirror id).
 *   - DemoAvailabilityOverride — per-day availability tweak (block / custom
 *                               hours), optionally recurring, optionally scoped
 *                               to a product profile.
 *   - DemoFeedback            — one 1-5 star rating + comment per completed demo.
 *   - DemoProductProfile      — a bookable product/listing's scheduling config
 *                               (duration, hours, days, buffer).
 *   - DemoWaitlist            — a guest waiting for a slot on a preferred date.
 *
 * Invariants the Postgres schema/app relied on, re-implemented inside mutations
 * (Convex has no UNIQUE/CHECK):
 *   - One feedback row per demo (the POST read-then-insert in feedback/route).
 *   - One availability override per (space, date, productProfile) — the app's
 *     delete-existing-then-insert (PG had a UNIQUE on (spaceId, date), but the
 *     app keys on the product too and handles the NULL-product case manually).
 *   - One waitlist 'waiting' row per (space, guestEmail, preferredDate) — the
 *     POST duplicate check.
 *   - Atomic conflict-checked booking (the book_demo_atomic plpgsql function:
 *     lock overlapping demos, count conflicts, insert iff none) -> one
 *     serializable mutation (convex/demos/demos.ts:book).
 */
export const demosTables = {
  // Was: "Demo" (TEXT id, spaceId, contactId nullable, productProfileId nullable,
  // guestName, guestEmail, guestPhone nullable, productAddress nullable, notes
  // nullable, startsAt/endsAt TIMESTAMPTZ, status CHECK enum default 'scheduled',
  // googleEventId nullable, manageToken nullable, createdAt, updatedAt, productId
  // nullable).
  Demo: defineTable({
    id: v.string(),
    spaceId: v.string(),
    contactId: v.optional(v.string()),
    productProfileId: v.optional(v.string()),
    guestName: v.string(),
    guestEmail: v.string(),
    guestPhone: v.optional(v.string()),
    productAddress: v.optional(v.string()),
    notes: v.optional(v.string()),
    startsAt: v.string(), // ISO-8601 (was TIMESTAMPTZ)
    endsAt: v.string(), // ISO-8601 (was TIMESTAMPTZ)
    status: v.union(
      v.literal('scheduled'),
      v.literal('confirmed'),
      v.literal('completed'),
      v.literal('cancelled'),
      v.literal('no_show'),
    ),
    googleEventId: v.optional(v.string()),
    manageToken: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    productId: v.optional(v.string()),
  })
    // Per-row reads/patches/deletes by id (GET/PATCH/DELETE /api/demos/[id],
    // prep, gcal sync, cards, portal respond, cancel/reschedule tools).
    .index('by_app_id', ['id'])
    // The dominant access pattern: a space's demos filtered/ordered on startsAt
    // (PG idx_demo_space_starts = (spaceId, startsAt DESC)). Booking-overlap
    // scans, upcoming lists, list_demos, availability, today, search base, and
    // the status-scoped reads (status filtered in the handler) all ride this.
    .index('by_space_starts', ['spaceId', 'startsAt'])
    // A contact's demos (PG idx_demo_contact). Used by the contact timeline,
    // portal/apply status, merge_persons (count + re-point by contactId), and
    // prep's "previous demos" count. contactId is 1:1 with a space, so the
    // handlers that also pass spaceId assert it after the index narrows.
    .index('by_contact', ['contactId'])
    // Guest self-service + feedback look a demo up by its manage token
    // (PG idx_demo_manage_token).
    .index('by_manage_token', ['manageToken'])
    // Demos for a product/listing (PG idx_demo_product). products/[id] detail
    // and the seller product page filter productId + spaceId, order startsAt.
    .index('by_product', ['productId'])
    // Cross-space cron reminder sweep ranges on startsAt with no space filter
    // (status filtered in the handler). PG ran this on idx_demo_status; a plain
    // startsAt index lets the time range be the index bound instead.
    .index('by_starts', ['startsAt']),

  // Was: "DemoAvailabilityOverride" (TEXT id, spaceId, productProfileId nullable,
  // date `date`, isBlocked bool default false, startHour/endHour integer nullable,
  // label nullable, recurrence CHECK enum default 'none', endDate `date` nullable,
  // createdAt). `date`/`endDate` are the Postgres `date` strings (YYYY-MM-DD) the
  // app compares lexically.
  DemoAvailabilityOverride: defineTable({
    id: v.string(),
    spaceId: v.string(),
    productProfileId: v.optional(v.string()),
    date: v.string(), // 'YYYY-MM-DD' (was Postgres `date`)
    isBlocked: v.boolean(),
    startHour: v.optional(v.number()),
    endHour: v.optional(v.number()),
    label: v.optional(v.string()),
    recurrence: v.union(
      v.literal('none'),
      v.literal('weekly'),
      v.literal('biweekly'),
      v.literal('monthly'),
    ),
    endDate: v.optional(v.string()), // 'YYYY-MM-DD' or absent
    createdAt: v.string(), // ISO-8601
  })
    // The availability calculator and the overrides list read all of a space's
    // overrides (PG idx_override_space). The (space,date) UNIQUE invariant
    // (PG idx_override_space_date) is enforced by the upsert mutation's
    // read-by-(space,date[,product])-then-delete-then-insert, which rides the
    // same index. by_app_id is the DELETE-by-id path.
    .index('by_space_date', ['spaceId', 'date'])
    .index('by_app_id', ['id']),

  // Was: "DemoFeedback" (TEXT id [PG default uuid — the app omitted it on insert],
  // demoId, spaceId, rating integer CHECK 1..5, comment nullable, createdAt
  // [PG default now() — also omitted on insert]). One row per demo (POST read-
  // then-insert), enforced in the create mutation.
  DemoFeedback: defineTable({
    id: v.string(),
    demoId: v.string(),
    spaceId: v.string(),
    rating: v.number(), // 1..5, validated by the route + mutation
    comment: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // "Feedback for this demo" — the existence check on POST and the agent GET
    // by demoId (PG idx_demo_feedback_demo). One row per demo, so this is the
    // .unique() read path.
    .index('by_demo', ['demoId'])
    // A space's feedback newest-first (PG idx_demo_feedback_space).
    .index('by_space', ['spaceId']),

  // Was: "DemoProductProfile" (TEXT id, spaceId, name, address nullable,
  // demoDuration integer default 30, startHour default 9, endHour default 17,
  // daysAvailable integer[] default {1..5}, bufferMinutes integer default 0,
  // isActive bool default true, createdAt, updatedAt).
  DemoProductProfile: defineTable({
    id: v.string(),
    spaceId: v.string(),
    name: v.string(),
    address: v.optional(v.string()),
    demoDuration: v.number(),
    startHour: v.number(),
    endHour: v.number(),
    daysAvailable: v.array(v.number()), // was integer[]
    bufferMinutes: v.number(),
    isActive: v.boolean(),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // A space's profiles ordered by createdAt (PG idx_product_profile_space).
    // The booking page, overrides validation, and the profiles list all scope
    // by spaceId.
    .index('by_space', ['spaceId'])
    // PATCH/DELETE and the booking/override flows look a profile up by id.
    .index('by_app_id', ['id']),

  // Was: "DemoWaitlist" (TEXT id, spaceId, productProfileId nullable, guestName,
  // guestEmail, guestPhone nullable, preferredDate `date`, notes nullable,
  // status CHECK enum default 'waiting', notifiedAt/expiresAt TIMESTAMPTZ
  // nullable, createdAt). preferredDate is the Postgres `date` string.
  DemoWaitlist: defineTable({
    id: v.string(),
    spaceId: v.string(),
    productProfileId: v.optional(v.string()),
    guestName: v.string(),
    guestEmail: v.string(),
    guestPhone: v.optional(v.string()),
    preferredDate: v.string(), // 'YYYY-MM-DD' (was Postgres `date`)
    notes: v.optional(v.string()),
    status: v.union(
      v.literal('waiting'),
      v.literal('notified'),
      v.literal('booked'),
      v.literal('expired'),
    ),
    notifiedAt: v.optional(v.string()), // ISO-8601 or absent
    expiresAt: v.optional(v.string()), // ISO-8601 or absent
    createdAt: v.string(), // ISO-8601
  })
    // A space's waitlist ordered by preferredDate (PG idx_waitlist_space_date =
    // (spaceId, preferredDate)). The list (status in waiting/notified), the
    // notification count (status=waiting), and the POST duplicate check
    // ((space, email, date, status=waiting)) all scope by spaceId first.
    .index('by_space_date', ['spaceId', 'preferredDate'])
    // notify looks an entry up by id (scoped to space + status=waiting).
    .index('by_app_id', ['id']),
};
