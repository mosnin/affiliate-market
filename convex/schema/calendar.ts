import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Calendar domain tables. See convex/CONVENTIONS.md for the Postgres -> Convex
 * translation rules every table here follows (string `id`, ISO timestamps,
 * CHECK enums -> v.union of v.literal, nullable -> v.optional, jsonb -> v.any).
 *
 * Four tables:
 *   - CalendarEvent       — manual/agent "blocked"/custom day entries (date+time).
 *   - CalendarEventMirror — forensic backup of events written through to an
 *                           external calendar (Composio). One row per write.
 *   - CalendarNote        — free-text note pinned to a calendar date.
 *   - GoogleCalendarToken — one OAuth token row per space (Google Calendar).
 *
 * GoogleCalendarToken stores OAuth secrets that the app layer encrypts before
 * write and decrypts/passes-through on read (lib/crypto). They stay v.string()
 * here — the crypto is unchanged; Convex just holds the ciphertext.
 */
export const calendarTables = {
  // Was: "CalendarEvent" (TEXT id, spaceId, title, description nullable, date,
  // time nullable, color nullable default 'gray', createdAt). `date`/`time` are
  // stored as the Postgres `date`/`text` strings (YYYY-MM-DD / HH:MM) the
  // callers already produce and compare lexically.
  CalendarEvent: defineTable({
    id: v.string(),
    spaceId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    date: v.string(), // 'YYYY-MM-DD' (was Postgres `date`)
    time: v.optional(v.string()), // 'HH:MM' or absent for all-day
    color: v.optional(v.string()), // default 'gray' applied by the writer
    createdAt: v.string(), // ISO-8601
  })
    // Every read filters by spaceId and ranges/orders on `date` (availability
    // scans, list_calendar_events, voice context). Compound index lets the
    // range run on `date` after the equality on `spaceId`.
    .index('by_space_date', ['spaceId', 'date']),

  // Was: "CalendarEventMirror" (TEXT id, spaceId, externalProvider, externalEventId
  // nullable, title, start, end, attendees jsonb default '[]', sourceDemoId nullable,
  // createdAt, createdBy CHECK ('agent'|'seller') default 'agent').
  CalendarEventMirror: defineTable({
    id: v.string(),
    spaceId: v.string(),
    externalProvider: v.string(), // 'googlecalendar' | 'outlook_calendar' (no PG CHECK)
    externalEventId: v.optional(v.string()), // absent when the external write failed
    title: v.string(),
    start: v.string(), // ISO-8601 (was TIMESTAMPTZ)
    end: v.string(), // ISO-8601 (was TIMESTAMPTZ)
    attendees: v.any(), // jsonb array of { email, name } — defaults to []
    sourceDemoId: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    createdBy: v.union(v.literal('agent'), v.literal('seller')), // CHECK enum
  })
    // No call site reads this table today (insert-only forensics). spaceId index
    // is the natural lookup for the eventual "show me what we mirrored" view and
    // mirrors the PG access pattern; cheap to define now so a reader needn't
    // touch the schema later.
    .index('by_space', ['spaceId']),

  // Was: "CalendarNote" (TEXT id, spaceId, date, note, createdAt). No read/write
  // call sites exist in the codebase today; the table is carried so the schema
  // stays complete. by_space_date matches the only sane future query (notes for
  // a space on/after a date).
  CalendarNote: defineTable({
    id: v.string(),
    spaceId: v.string(),
    date: v.string(), // 'YYYY-MM-DD' (was Postgres `date`)
    note: v.string(),
    createdAt: v.string(), // ISO-8601
  }).index('by_space_date', ['spaceId', 'date']),

  // Was: "GoogleCalendarToken" (TEXT id, spaceId, accessToken, refreshToken,
  // expiresAt, calendarId default 'primary', createdAt, updatedAt). Tokens are
  // ciphertext at rest — kept v.string(); the app layer owns encrypt/decrypt.
  //
  // PG had an upsert keyed on spaceId (one token row per space). Convex has no
  // unique constraint, so the upsert mutation re-implements it as read-by-space
  // -then-patch-or-insert inside one (serializable) mutation.
  GoogleCalendarToken: defineTable({
    id: v.string(),
    spaceId: v.string(),
    accessToken: v.string(), // encrypted at rest (lib/crypto)
    refreshToken: v.string(), // encrypted at rest (lib/crypto)
    expiresAt: v.string(), // ISO-8601
    calendarId: v.string(), // default 'primary'
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // Every access is "the token for this space" (status/connect, refresh,
    // freeBusy, sync, disconnect). One-token-per-space is enforced by the
    // upsert mutation, so .unique() on this index is the read path.
    .index('by_space', ['spaceId']),
};
