import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Email domain tables. See convex/CONVENTIONS.md for the Postgres -> Convex
 * translation rules every table here follows (string `id`, ISO `createdAt`,
 * CHECK enums -> v.union of v.literal, etc.).
 */
export const emailTables = {
  // Was: "EmailSuppression" (TEXT id, email, listType CHECK enum, createdAt).
  // The unique (email, listType) index that enforced one opt-out per address is
  // preserved as `by_email_list`; the suppress mutation reads it then inserts,
  // which is transactional in Convex (stronger than the old PG upsert).
  EmailSuppression: defineTable({
    id: v.string(),
    email: v.string(), // always stored lower-cased by the writer
    listType: v.union(v.literal('creator_digest'), v.literal('seller_digest')),
    createdAt: v.string(), // ISO-8601
  })
    // No by_app_id index: nothing looks EmailSuppression up by id. (Tables that
    // ARE referenced by their string id get a `by_app_id` index — never `by_id`,
    // which Convex reserves.)
    .index('by_email_list', ['email', 'listType']),
};
