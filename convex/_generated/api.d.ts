/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as calendar_events from "../calendar/events.js";
import type * as calendar_mirrors from "../calendar/mirrors.js";
import type * as calendar_tokens from "../calendar/tokens.js";
import type * as credits_lots from "../credits/lots.js";
import type * as credits_txns from "../credits/txns.js";
import type * as email_suppression from "../email/suppression.js";
import type * as integrations_companyConnections from "../integrations/companyConnections.js";
import type * as integrations_connections from "../integrations/connections.js";
import type * as integrations_triggers from "../integrations/triggers.js";
import type * as notifications_announcements from "../notifications/announcements.js";
import type * as notifications_dismissals from "../notifications/dismissals.js";
import type * as notifications_manager from "../notifications/manager.js";
import type * as notifications_push from "../notifications/push.js";
import type * as schema_calendar from "../schema/calendar.js";
import type * as schema_credits from "../schema/credits.js";
import type * as schema_email from "../schema/email.js";
import type * as schema_integrations from "../schema/integrations.js";
import type * as schema_notifications from "../schema/notifications.js";
import type * as schema_studio from "../schema/studio.js";
import type * as schema_support from "../schema/support.js";
import type * as studio_brand from "../studio/brand.js";
import type * as studio_generations from "../studio/generations.js";
import type * as studio_posts from "../studio/posts.js";
import type * as support_broadcasts from "../support/broadcasts.js";
import type * as support_calls from "../support/calls.js";
import type * as support_templates from "../support/templates.js";
import type * as support_tickets from "../support/tickets.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "calendar/events": typeof calendar_events;
  "calendar/mirrors": typeof calendar_mirrors;
  "calendar/tokens": typeof calendar_tokens;
  "credits/lots": typeof credits_lots;
  "credits/txns": typeof credits_txns;
  "email/suppression": typeof email_suppression;
  "integrations/companyConnections": typeof integrations_companyConnections;
  "integrations/connections": typeof integrations_connections;
  "integrations/triggers": typeof integrations_triggers;
  "notifications/announcements": typeof notifications_announcements;
  "notifications/dismissals": typeof notifications_dismissals;
  "notifications/manager": typeof notifications_manager;
  "notifications/push": typeof notifications_push;
  "schema/calendar": typeof schema_calendar;
  "schema/credits": typeof schema_credits;
  "schema/email": typeof schema_email;
  "schema/integrations": typeof schema_integrations;
  "schema/notifications": typeof schema_notifications;
  "schema/studio": typeof schema_studio;
  "schema/support": typeof schema_support;
  "studio/brand": typeof studio_brand;
  "studio/generations": typeof studio_generations;
  "studio/posts": typeof studio_posts;
  "support/broadcasts": typeof support_broadcasts;
  "support/calls": typeof support_calls;
  "support/templates": typeof support_templates;
  "support/tickets": typeof support_tickets;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
