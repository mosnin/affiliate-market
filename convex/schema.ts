import { defineSchema } from 'convex/server';
import { emailTables } from './schema/email';
import { creditsTables } from './schema/credits';
import { studioTables } from './schema/studio';
import { calendarTables } from './schema/calendar';

/**
 * Convex schema for Cola — the migration target replacing Supabase/Postgres.
 *
 * The schema is assembled from per-domain fragments under convex/schema/* so the
 * ~116 tables can be translated in parallel without co-editing one file. Each
 * fragment exports a `{ TableName: defineTable(...) }` map; this file spreads
 * them all into a single defineSchema. Add a domain by importing its fragment
 * and spreading it below.
 *
 * Translation rules: convex/CONVENTIONS.md.
 */
export default defineSchema({
  ...emailTables,
  ...creditsTables,
  ...studioTables,
  ...calendarTables,
});
