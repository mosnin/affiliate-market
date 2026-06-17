import { defineSchema } from 'convex/server';
import { emailTables } from './schema/email';
import { creditsTables } from './schema/credits';
import { studioTables } from './schema/studio';
import { calendarTables } from './schema/calendar';
import { integrationsTables } from './schema/integrations';
import { notificationsTables } from './schema/notifications';
import { supportTables } from './schema/support';
import { marketplaceTables } from './schema/marketplace';
import { demosTables } from './schema/demos';
import { contactsTables } from './schema/contacts';
import { dealsTables } from './schema/deals';
import { workspaceTables } from './schema/workspace';
import { orgTables } from './schema/org';
import { affiliatesTables } from './schema/affiliates';
import { agentTables } from './schema/agent';
import { conversationsTables } from './schema/conversations';
import { swarmvectorTables } from './schema/swarmvector';
import { infraTables } from './schema/infra';
import { portalTables } from './schema/portal';

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
  ...integrationsTables,
  ...notificationsTables,
  ...supportTables,
  ...marketplaceTables,
  ...demosTables,
  ...contactsTables,
  ...dealsTables,
  ...workspaceTables,
  ...orgTables,
  ...affiliatesTables,
  ...agentTables,
  ...conversationsTables,
  ...swarmvectorTables,
  ...infraTables,
  ...portalTables,
});
