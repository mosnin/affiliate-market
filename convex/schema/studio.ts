import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Studio domain tables — the AI content studio (brand kit, generations, and
 * scheduled social posts). See convex/CONVENTIONS.md for the Postgres -> Convex
 * translation rules every table here follows (string `id`, ISO timestamps,
 * CHECK enums -> v.union of v.literal, nullable -> v.optional, jsonb -> v.any,
 * numeric -> v.number, text[] -> v.array(v.string()), bool -> v.boolean).
 */
export const studioTables = {
  // Was: "StudioBrand" — one brand kit row per space (palette, fonts, social
  // handles, voice). Postgres enforced one-per-space via a unique index on
  // spaceId, which the PUT route relied on through upsert(onConflict:'spaceId').
  // Convex has no unique constraint, so upsertBrand reads `by_space` then
  // inserts-or-patches inside one serializable mutation to preserve that
  // invariant. colors/fonts/handles default to empty in PG (NOT NULL) — kept
  // required here; the writers always supply them.
  StudioBrand: defineTable({
    id: v.string(),
    spaceId: v.string(),
    logoFileId: v.optional(v.string()),
    headshotFileId: v.optional(v.string()),
    colors: v.array(v.string()),
    fonts: v.any(), // jsonb
    handles: v.any(), // jsonb
    voice: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // Every read and the upsert look the row up by spaceId (one per space).
    .index('by_space', ['spaceId']),

  // Was: "StudioGeneration" — one row per fal.ai image/video generation or
  // edit, with status, dollar cost, and the resulting File id. kind and status
  // were CHECK enums in PG.
  StudioGeneration: defineTable({
    id: v.string(),
    spaceId: v.string(),
    userId: v.string(),
    fileId: v.optional(v.string()),
    sourceFileId: v.optional(v.string()),
    kind: v.union(v.literal('image'), v.literal('video')),
    model: v.string(),
    prompt: v.optional(v.string()),
    status: v.union(
      v.literal('pending'),
      v.literal('running'),
      v.literal('completed'),
      v.literal('failed'),
    ),
    costUsd: v.number(), // numeric(10,6) — fractional dollars (NOT integer cents)
    falRequestId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    completedAt: v.optional(v.string()), // ISO-8601
    createdAt: v.string(), // ISO-8601
  })
    // Status/sourceFileId/createdAt filters all scope to one space first
    // (library, recent-job, spend-today). Compound (spaceId, createdAt) serves
    // the createdAt-desc ordering and the spend window range on the index.
    .index('by_space_created', ['spaceId', 'createdAt'])
    // Generations are patched by their string id (mark running/failed/completed).
    .index('by_app_id', ['id']),

  // Was: "StudioPost" — a scheduled social post (image + caption + platforms +
  // time), published by the Inngest publishScheduledPost function. status was a
  // CHECK enum; platforms is text[]; platformResults is jsonb.
  StudioPost: defineTable({
    id: v.string(),
    spaceId: v.string(),
    userId: v.string(),
    fileId: v.string(),
    caption: v.string(),
    platforms: v.array(v.string()),
    scheduledAt: v.string(), // ISO-8601
    status: v.union(
      v.literal('scheduled'),
      v.literal('publishing'),
      v.literal('posted'),
      v.literal('failed'),
      v.literal('canceled'),
    ),
    platformResults: v.any(), // jsonb
    inngestEventId: v.optional(v.string()),
    postedAt: v.optional(v.string()), // ISO-8601
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // The schedule list reads a space's posts ordered by scheduledAt asc.
    .index('by_space_scheduled', ['spaceId', 'scheduledAt'])
    // Posts are looked up and patched by their string id (claim/finalize/cancel,
    // Inngest load-post). The cancel + claim CAS on status are done in-handler.
    .index('by_app_id', ['id']),
};
