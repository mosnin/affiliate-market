/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as affiliates_clicks from "../affiliates/clicks.js";
import type * as affiliates_commissions from "../affiliates/commissions.js";
import type * as affiliates_ledger from "../affiliates/ledger.js";
import type * as affiliates_links from "../affiliates/links.js";
import type * as affiliates_partners from "../affiliates/partners.js";
import type * as affiliates_payouts from "../affiliates/payouts.js";
import type * as affiliates_profiles from "../affiliates/profiles.js";
import type * as affiliates_programs from "../affiliates/programs.js";
import type * as affiliates_referrals from "../affiliates/referrals.js";
import type * as affiliates_splits from "../affiliates/splits.js";
import type * as agent_activity from "../agent/activity.js";
import type * as agent_checkpoints from "../agent/checkpoints.js";
import type * as agent_cleanup from "../agent/cleanup.js";
import type * as agent_customAgents from "../agent/customAgents.js";
import type * as agent_dependencies from "../agent/dependencies.js";
import type * as agent_drafts from "../agent/drafts.js";
import type * as agent_goalDecomposition from "../agent/goalDecomposition.js";
import type * as agent_goals from "../agent/goals.js";
import type * as agent_paused from "../agent/paused.js";
import type * as agent_questions from "../agent/questions.js";
import type * as agent_routines from "../agent/routines.js";
import type * as agent_settings from "../agent/settings.js";
import type * as agent_steps from "../agent/steps.js";
import type * as agent_tasks from "../agent/tasks.js";
import type * as calendar_events from "../calendar/events.js";
import type * as calendar_mirrors from "../calendar/mirrors.js";
import type * as calendar_tokens from "../calendar/tokens.js";
import type * as contacts_activity from "../contacts/activity.js";
import type * as contacts_contacts from "../contacts/contacts.js";
import type * as contacts_documents from "../contacts/documents.js";
import type * as contacts_profiles from "../contacts/profiles.js";
import type * as conversations_artifacts from "../conversations/artifacts.js";
import type * as conversations_clientMessages from "../conversations/clientMessages.js";
import type * as conversations_conversations from "../conversations/conversations.js";
import type * as conversations_managerConversations from "../conversations/managerConversations.js";
import type * as conversations_managerMessages from "../conversations/managerMessages.js";
import type * as conversations_messages from "../conversations/messages.js";
import type * as credits_lots from "../credits/lots.js";
import type * as credits_purge from "../credits/purge.js";
import type * as credits_txns from "../credits/txns.js";
import type * as deals_activity from "../deals/activity.js";
import type * as deals_checklist from "../deals/checklist.js";
import type * as deals_contacts from "../deals/contacts.js";
import type * as deals_deals from "../deals/deals.js";
import type * as deals_documents from "../deals/documents.js";
import type * as deals_notes from "../deals/notes.js";
import type * as deals_pipelines from "../deals/pipelines.js";
import type * as deals_review from "../deals/review.js";
import type * as deals_routing from "../deals/routing.js";
import type * as deals_stages from "../deals/stages.js";
import type * as demos_availability from "../demos/availability.js";
import type * as demos_demos from "../demos/demos.js";
import type * as demos_feedback from "../demos/feedback.js";
import type * as demos_profiles from "../demos/profiles.js";
import type * as demos_waitlist from "../demos/waitlist.js";
import type * as email_suppression from "../email/suppression.js";
import type * as infra_attachments from "../infra/attachments.js";
import type * as infra_auditLog from "../infra/auditLog.js";
import type * as infra_chatUsage from "../infra/chatUsage.js";
import type * as infra_deadLetter from "../infra/deadLetter.js";
import type * as infra_files from "../infra/files.js";
import type * as infra_mcpApiKeys from "../infra/mcpApiKeys.js";
import type * as infra_mcpAuthCodes from "../infra/mcpAuthCodes.js";
import type * as infra_stripeBridge from "../infra/stripeBridge.js";
import type * as infra_telemetry from "../infra/telemetry.js";
import type * as integrations_companyConnections from "../integrations/companyConnections.js";
import type * as integrations_connections from "../integrations/connections.js";
import type * as integrations_triggers from "../integrations/triggers.js";
import type * as marketplace_orders from "../marketplace/orders.js";
import type * as marketplace_packets from "../marketplace/packets.js";
import type * as marketplace_products from "../marketplace/products.js";
import type * as marketplace_profiles from "../marketplace/profiles.js";
import type * as marketplace_refunds from "../marketplace/refunds.js";
import type * as marketplace_reviews from "../marketplace/reviews.js";
import type * as marketplace_views from "../marketplace/views.js";
import type * as notifications_announcements from "../notifications/announcements.js";
import type * as notifications_dismissals from "../notifications/dismissals.js";
import type * as notifications_manager from "../notifications/manager.js";
import type * as notifications_push from "../notifications/push.js";
import type * as org_companies from "../org/companies.js";
import type * as org_invitations from "../org/invitations.js";
import type * as org_memberships from "../org/memberships.js";
import type * as org_templates from "../org/templates.js";
import type * as org_users from "../org/users.js";
import type * as portal_applicationMessages from "../portal/applicationMessages.js";
import type * as portal_applicationStatus from "../portal/applicationStatus.js";
import type * as portal_briefTips from "../portal/briefTips.js";
import type * as portal_briefs from "../portal/briefs.js";
import type * as portal_clientAuthCodes from "../portal/clientAuthCodes.js";
import type * as portal_clientDocuments from "../portal/clientDocuments.js";
import type * as portal_clientInfoRequests from "../portal/clientInfoRequests.js";
import type * as portal_clientUsers from "../portal/clientUsers.js";
import type * as portal_cmaReports from "../portal/cmaReports.js";
import type * as portal_formAnalytics from "../portal/formAnalytics.js";
import type * as portal_formDrafts from "../portal/formDrafts.js";
import type * as portal_signatures from "../portal/signatures.js";
import type * as schema_affiliates from "../schema/affiliates.js";
import type * as schema_agent from "../schema/agent.js";
import type * as schema_calendar from "../schema/calendar.js";
import type * as schema_contacts from "../schema/contacts.js";
import type * as schema_conversations from "../schema/conversations.js";
import type * as schema_credits from "../schema/credits.js";
import type * as schema_deals from "../schema/deals.js";
import type * as schema_demos from "../schema/demos.js";
import type * as schema_email from "../schema/email.js";
import type * as schema_infra from "../schema/infra.js";
import type * as schema_integrations from "../schema/integrations.js";
import type * as schema_marketplace from "../schema/marketplace.js";
import type * as schema_notifications from "../schema/notifications.js";
import type * as schema_org from "../schema/org.js";
import type * as schema_portal from "../schema/portal.js";
import type * as schema_studio from "../schema/studio.js";
import type * as schema_support from "../schema/support.js";
import type * as schema_swarmvector from "../schema/swarmvector.js";
import type * as schema_workspace from "../schema/workspace.js";
import type * as studio_brand from "../studio/brand.js";
import type * as studio_generations from "../studio/generations.js";
import type * as studio_posts from "../studio/posts.js";
import type * as support_broadcasts from "../support/broadcasts.js";
import type * as support_calls from "../support/calls.js";
import type * as support_templates from "../support/templates.js";
import type * as support_tickets from "../support/tickets.js";
import type * as swarmvector_agentMemory from "../swarmvector/agentMemory.js";
import type * as swarmvector_documentEmbedding from "../swarmvector/documentEmbedding.js";
import type * as swarmvector_swarmEvents from "../swarmvector/swarmEvents.js";
import type * as swarmvector_swarmMembers from "../swarmvector/swarmMembers.js";
import type * as swarmvector_swarmRuns from "../swarmvector/swarmRuns.js";
import type * as workspace_disabled from "../workspace/disabled.js";
import type * as workspace_settings from "../workspace/settings.js";
import type * as workspace_spaces from "../workspace/spaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "affiliates/clicks": typeof affiliates_clicks;
  "affiliates/commissions": typeof affiliates_commissions;
  "affiliates/ledger": typeof affiliates_ledger;
  "affiliates/links": typeof affiliates_links;
  "affiliates/partners": typeof affiliates_partners;
  "affiliates/payouts": typeof affiliates_payouts;
  "affiliates/profiles": typeof affiliates_profiles;
  "affiliates/programs": typeof affiliates_programs;
  "affiliates/referrals": typeof affiliates_referrals;
  "affiliates/splits": typeof affiliates_splits;
  "agent/activity": typeof agent_activity;
  "agent/checkpoints": typeof agent_checkpoints;
  "agent/cleanup": typeof agent_cleanup;
  "agent/customAgents": typeof agent_customAgents;
  "agent/dependencies": typeof agent_dependencies;
  "agent/drafts": typeof agent_drafts;
  "agent/goalDecomposition": typeof agent_goalDecomposition;
  "agent/goals": typeof agent_goals;
  "agent/paused": typeof agent_paused;
  "agent/questions": typeof agent_questions;
  "agent/routines": typeof agent_routines;
  "agent/settings": typeof agent_settings;
  "agent/steps": typeof agent_steps;
  "agent/tasks": typeof agent_tasks;
  "calendar/events": typeof calendar_events;
  "calendar/mirrors": typeof calendar_mirrors;
  "calendar/tokens": typeof calendar_tokens;
  "contacts/activity": typeof contacts_activity;
  "contacts/contacts": typeof contacts_contacts;
  "contacts/documents": typeof contacts_documents;
  "contacts/profiles": typeof contacts_profiles;
  "conversations/artifacts": typeof conversations_artifacts;
  "conversations/clientMessages": typeof conversations_clientMessages;
  "conversations/conversations": typeof conversations_conversations;
  "conversations/managerConversations": typeof conversations_managerConversations;
  "conversations/managerMessages": typeof conversations_managerMessages;
  "conversations/messages": typeof conversations_messages;
  "credits/lots": typeof credits_lots;
  "credits/purge": typeof credits_purge;
  "credits/txns": typeof credits_txns;
  "deals/activity": typeof deals_activity;
  "deals/checklist": typeof deals_checklist;
  "deals/contacts": typeof deals_contacts;
  "deals/deals": typeof deals_deals;
  "deals/documents": typeof deals_documents;
  "deals/notes": typeof deals_notes;
  "deals/pipelines": typeof deals_pipelines;
  "deals/review": typeof deals_review;
  "deals/routing": typeof deals_routing;
  "deals/stages": typeof deals_stages;
  "demos/availability": typeof demos_availability;
  "demos/demos": typeof demos_demos;
  "demos/feedback": typeof demos_feedback;
  "demos/profiles": typeof demos_profiles;
  "demos/waitlist": typeof demos_waitlist;
  "email/suppression": typeof email_suppression;
  "infra/attachments": typeof infra_attachments;
  "infra/auditLog": typeof infra_auditLog;
  "infra/chatUsage": typeof infra_chatUsage;
  "infra/deadLetter": typeof infra_deadLetter;
  "infra/files": typeof infra_files;
  "infra/mcpApiKeys": typeof infra_mcpApiKeys;
  "infra/mcpAuthCodes": typeof infra_mcpAuthCodes;
  "infra/stripeBridge": typeof infra_stripeBridge;
  "infra/telemetry": typeof infra_telemetry;
  "integrations/companyConnections": typeof integrations_companyConnections;
  "integrations/connections": typeof integrations_connections;
  "integrations/triggers": typeof integrations_triggers;
  "marketplace/orders": typeof marketplace_orders;
  "marketplace/packets": typeof marketplace_packets;
  "marketplace/products": typeof marketplace_products;
  "marketplace/profiles": typeof marketplace_profiles;
  "marketplace/refunds": typeof marketplace_refunds;
  "marketplace/reviews": typeof marketplace_reviews;
  "marketplace/views": typeof marketplace_views;
  "notifications/announcements": typeof notifications_announcements;
  "notifications/dismissals": typeof notifications_dismissals;
  "notifications/manager": typeof notifications_manager;
  "notifications/push": typeof notifications_push;
  "org/companies": typeof org_companies;
  "org/invitations": typeof org_invitations;
  "org/memberships": typeof org_memberships;
  "org/templates": typeof org_templates;
  "org/users": typeof org_users;
  "portal/applicationMessages": typeof portal_applicationMessages;
  "portal/applicationStatus": typeof portal_applicationStatus;
  "portal/briefTips": typeof portal_briefTips;
  "portal/briefs": typeof portal_briefs;
  "portal/clientAuthCodes": typeof portal_clientAuthCodes;
  "portal/clientDocuments": typeof portal_clientDocuments;
  "portal/clientInfoRequests": typeof portal_clientInfoRequests;
  "portal/clientUsers": typeof portal_clientUsers;
  "portal/cmaReports": typeof portal_cmaReports;
  "portal/formAnalytics": typeof portal_formAnalytics;
  "portal/formDrafts": typeof portal_formDrafts;
  "portal/signatures": typeof portal_signatures;
  "schema/affiliates": typeof schema_affiliates;
  "schema/agent": typeof schema_agent;
  "schema/calendar": typeof schema_calendar;
  "schema/contacts": typeof schema_contacts;
  "schema/conversations": typeof schema_conversations;
  "schema/credits": typeof schema_credits;
  "schema/deals": typeof schema_deals;
  "schema/demos": typeof schema_demos;
  "schema/email": typeof schema_email;
  "schema/infra": typeof schema_infra;
  "schema/integrations": typeof schema_integrations;
  "schema/marketplace": typeof schema_marketplace;
  "schema/notifications": typeof schema_notifications;
  "schema/org": typeof schema_org;
  "schema/portal": typeof schema_portal;
  "schema/studio": typeof schema_studio;
  "schema/support": typeof schema_support;
  "schema/swarmvector": typeof schema_swarmvector;
  "schema/workspace": typeof schema_workspace;
  "studio/brand": typeof studio_brand;
  "studio/generations": typeof studio_generations;
  "studio/posts": typeof studio_posts;
  "support/broadcasts": typeof support_broadcasts;
  "support/calls": typeof support_calls;
  "support/templates": typeof support_templates;
  "support/tickets": typeof support_tickets;
  "swarmvector/agentMemory": typeof swarmvector_agentMemory;
  "swarmvector/documentEmbedding": typeof swarmvector_documentEmbedding;
  "swarmvector/swarmEvents": typeof swarmvector_swarmEvents;
  "swarmvector/swarmMembers": typeof swarmvector_swarmMembers;
  "swarmvector/swarmRuns": typeof swarmvector_swarmRuns;
  "workspace/disabled": typeof workspace_disabled;
  "workspace/settings": typeof workspace_settings;
  "workspace/spaces": typeof workspace_spaces;
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
