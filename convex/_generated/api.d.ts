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
import type * as schema_calendar from "../schema/calendar.js";
import type * as schema_credits from "../schema/credits.js";
import type * as schema_email from "../schema/email.js";
import type * as schema_studio from "../schema/studio.js";
import type * as studio_brand from "../studio/brand.js";
import type * as studio_generations from "../studio/generations.js";
import type * as studio_posts from "../studio/posts.js";

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
  "schema/calendar": typeof schema_calendar;
  "schema/credits": typeof schema_credits;
  "schema/email": typeof schema_email;
  "schema/studio": typeof schema_studio;
  "studio/brand": typeof studio_brand;
  "studio/generations": typeof studio_generations;
  "studio/posts": typeof studio_posts;
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
