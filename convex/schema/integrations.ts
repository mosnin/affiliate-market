import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Integrations domain tables. See convex/CONVENTIONS.md for the Postgres ->
 * Convex translation rules every table here follows (string `id`, ISO
 * timestamps, CHECK enums -> v.union of v.literal, nullable -> v.optional,
 * jsonb -> v.any).
 *
 * Three tables, all backing the Composio integration story:
 *   - IntegrationConnection        — one pointer+status+audit row per connected
 *                                     app at the SPACE level (Composio holds the
 *                                     OAuth tokens; this row holds the pointer).
 *   - IntegrationTrigger           — one row per (connection, trigger slug); the
 *                                     inbound webhook subscriptions.
 *   - CompanyIntegrationConnection — the company-level analogue of
 *                                     IntegrationConnection.
 *
 * Postgres uniqueness invariants that encoded real business behavior (no native
 * Convex equivalent) are re-implemented inside the mutations as read-then-
 * patch/insert (serializable in one mutation):
 *   - IntegrationConnection_active_unique: unique (spaceId,userId,toolkit) WHERE
 *     status='active' — at most one active connection per (space,user,toolkit).
 *     The caller revokes the prior active row before inserting (revoke->insert),
 *     so the mutations don't enforce it themselves; the read paths (findActive)
 *     assume at most one and use .first().
 *   - CompanyIntegrationConnection_active_unique: same shape, company-scoped.
 *   - IntegrationTrigger_connection_slug_unique: unique (connectionId,triggerSlug)
 *     — the trigger upsert reads-by-(connectionId,triggerSlug)-then-patch-or-insert
 *     to preserve the old onConflict upsert.
 *
 * Status enums match the PG CHECK constraints. NOTE: IntegrationConnection /
 * CompanyIntegrationConnection statuses in PG are
 * ('active'|'expired'|'revoked'|'failed'), but the lib layer also writes
 * 'pending' (OAuth initiate-time rows that the callback promotes) — the PG CHECK
 * permits it because 'pending' was added to the app's status union without a
 * matching CHECK update. The Convex union includes every status the code writes
 * so a write never bounces.
 */

const connectionStatusValidator = v.union(
  v.literal('active'),
  v.literal('pending'),
  v.literal('expired'),
  v.literal('revoked'),
  v.literal('failed'),
);

const triggerStatusValidator = v.union(
  v.literal('active'),
  v.literal('paused'),
  v.literal('failed'),
);

export const integrationsTables = {
  // Was: "IntegrationConnection" (TEXT id, spaceId, userId, toolkit,
  // composioConnectionId, status CHECK default 'active', label nullable,
  // lastError nullable, lastUsedAt nullable, createdAt, updatedAt,
  // secretCiphertext nullable). secretCiphertext is an encrypted native
  // credential (lib/crypto) — kept v.string(); the crypto is unchanged.
  IntegrationConnection: defineTable({
    id: v.string(),
    spaceId: v.string(),
    userId: v.string(),
    toolkit: v.string(),
    composioConnectionId: v.string(),
    status: connectionStatusValidator, // default 'active' applied by the writer
    label: v.optional(v.string()),
    lastError: v.optional(v.string()),
    lastUsedAt: v.optional(v.string()), // ISO-8601
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    secretCiphertext: v.optional(v.string()), // encrypted at rest (lib/crypto)
  })
    // getById / setStatus / upsertByComposioId look rows up by string id.
    .index('by_app_id', ['id'])
    // OAuth callback + chat expire path look up by Composio's connection id
    // (IntegrationConnection has no PG index here, but every call site does an
    // eq on composioConnectionId; index it so the lookup isn't a table scan).
    .index('by_composio_id', ['composioConnectionId'])
    // The dominant read: connections for a space filtered by status (list,
    // active-toolkit scans, the banner count, delivery/mirror/signal-source
    // "find active for space by toolkit"). Mirrors IntegrationConnection_spaceId_idx
    // (spaceId, status). The toolkit filter runs as a post-index .filter().
    .index('by_space', ['spaceId', 'status'])
    // findActive / findPending / activeToolkits resolve a specific (space,user,
    // toolkit) — the columns of IntegrationConnection_active_unique. Lets those
    // point lookups run on an index and the status equality as a post-filter.
    .index('by_space_user_toolkit', ['spaceId', 'userId', 'toolkit']),

  // Was: "IntegrationTrigger" (TEXT id, connectionId, composioTriggerId nullable,
  // triggerSlug, status CHECK default 'active', lastFiredAt nullable, lastError
  // nullable, createdAt, updatedAt).
  IntegrationTrigger: defineTable({
    id: v.string(),
    connectionId: v.string(),
    composioTriggerId: v.optional(v.string()), // absent until Composio registers it
    triggerSlug: v.string(),
    status: triggerStatusValidator, // default 'active' applied by the writer
    lastFiredAt: v.optional(v.string()), // ISO-8601
    lastError: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // stampFired looks a trigger row up by string id.
    .index('by_app_id', ['id'])
    // list/delete/pause/summary all key on connectionId. Mirrors
    // IntegrationTrigger_connectionId_idx; also serves the (connectionId,
    // triggerSlug) upsert lookup and the (connectionId, triggerSlug, status)
    // attendee-fired read as a post-filter after the eq on connectionId.
    .index('by_connection', ['connectionId'])
    // The webhook receiver joins on Composio's trigger id. Mirrors
    // IntegrationTrigger_composioTriggerId_idx.
    .index('by_composio_trigger_id', ['composioTriggerId']),

  // Was: "CompanyIntegrationConnection" (TEXT id, companyId, userId, toolkit,
  // composioConnectionId, status CHECK default 'active', label nullable,
  // lastError nullable, lastUsedAt nullable, createdAt, updatedAt). No
  // secretCiphertext column at the company level (no native integrations there).
  CompanyIntegrationConnection: defineTable({
    id: v.string(),
    companyId: v.string(),
    userId: v.string(),
    toolkit: v.string(),
    composioConnectionId: v.string(),
    status: connectionStatusValidator, // default 'active' applied by the writer
    label: v.optional(v.string()),
    lastError: v.optional(v.string()),
    lastUsedAt: v.optional(v.string()), // ISO-8601
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // getCompanyConnectionById / setStatus / upsertByComposioId look up by id.
    .index('by_app_id', ['id'])
    // OAuth callback looks up by Composio's connection id.
    .index('by_composio_id', ['composioConnectionId'])
    // listCompanyConnections orders by createdAt for a company. Mirrors
    // CompanyIntegrationConnection_companyId_idx (companyId, status); the status
    // filter (when present) runs as a post-filter.
    .index('by_company', ['companyId'])
    // listCompanyConnectionsForUser + findActiveCompanyConnection resolve a
    // specific (company,user[,toolkit]) — the columns of
    // CompanyIntegrationConnection_active_unique / _userId_idx.
    .index('by_company_user_toolkit', ['companyId', 'userId', 'toolkit']),
};
