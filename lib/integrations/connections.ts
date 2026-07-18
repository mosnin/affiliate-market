/**
 * DB-side helpers for IntegrationConnection rows. The Composio SDK holds
 * the OAuth tokens; this table holds the pointer + status + audit. One
 * active row per (space, user, toolkit) — a reconnect flips the prior
 * row to 'revoked' and inserts a new 'active' row.
 */

import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { deleteConnection as composioDelete, listConnectedAccountsForEntity } from './composio';
import { findIntegration } from './catalog';

export type IntegrationStatus = 'active' | 'pending' | 'expired' | 'revoked' | 'failed';

export interface IntegrationConnectionRow {
  id: string;
  spaceId: string;
  userId: string;
  toolkit: string;
  composioConnectionId: string;
  status: IntegrationStatus;
  label: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Encrypted credential for native (non-Composio) integrations, e.g. a
   *  Follow Up Boss API key. Null/absent for every Composio-backed row. */
  secretCiphertext?: string | null;
}

/**
 * Best-effort reconcile from Composio → our DB. Pulls every active
 * connection Composio has for this user and upserts any our DB doesn't
 * know about. Recovery path for sellers who completed OAuth on the
 * old broken codebase (where the row was only persisted in the callback,
 * which was failing silently). Idempotent; safe to call on every
 * /settings load.
 *
 * Failures are swallowed (logged, not thrown) — a Composio outage should
 * not break the integrations panel from loading.
 */
export async function reconcileFromComposio(args: {
  spaceId: string;
  entityId: string;
}): Promise<void> {
  let list;
  try {
    list = await listConnectedAccountsForEntity({ entityId: args.entityId });
  } catch (err) {
    logger.warn('[integrations.connections] reconcile composio list failed', {
      entityId: args.entityId,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const items = ((list as { items?: unknown[] })?.items ?? []) as Array<{
    id?: string;
    status?: string;
    alias?: string | null;
    toolkit?: { slug?: string } | null;
  }>;

  for (const item of items) {
    if (!item.id || !item.toolkit?.slug) continue;
    if (item.status !== 'ACTIVE') continue;
    if (!findIntegration(item.toolkit.slug)) continue;

    const existing = await findByComposioId(item.id);
    if (existing) {
      // Self-heal: the connect route inserts rows as 'pending' and the OAuth
      // callback promotes them — but the callback is a cross-site redirect
      // that can drop. Composio says this account is ACTIVE, so promote the
      // pending row here (this runs on every /settings load).
      if (existing.status === 'pending') {
        await setStatus({ id: existing.id, status: 'active' });
        logger.info('[integrations.connections] promoted pending row via reconcile', {
          id: existing.id,
          toolkit: item.toolkit.slug,
        });
      }
      continue; // already tracked
    }

    // Composio has it, we don't — backfill.
    const inserted = await insertConnection({
      spaceId: args.spaceId,
      userId: args.entityId,
      toolkit: item.toolkit.slug,
      composioConnectionId: item.id,
      label: item.alias ?? undefined,
    });
    if (inserted) {
      logger.info('[integrations.connections] reconciled composio connection into DB', {
        composioConnectionId: item.id,
        toolkit: item.toolkit.slug,
        spaceId: args.spaceId,
      });
    }
  }
}

/** All connections for a space, regardless of status. UI filters as needed. */
export async function listConnections(spaceId: string): Promise<IntegrationConnectionRow[]> {
  try {
    const rows = await convex().query(api.integrations.connections.listBySpace, { spaceId });
    return rows as IntegrationConnectionRow[];
  } catch (err) {
    logger.warn('[integrations.connections] list failed', {
      spaceId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Active toolkit slugs for a given (space, user) — the chat agent reads this
 *  on every turn to decide which Composio tools to load. Hot path; keep tight. */
export async function activeToolkits(args: {
  spaceId: string;
  userId: string;
}): Promise<string[]> {
  try {
    return await convex().query(api.integrations.connections.activeToolkits, {
      spaceId: args.spaceId,
      userId: args.userId,
    });
  } catch (err) {
    logger.warn('[integrations.connections] activeToolkits failed', {
      spaceId: args.spaceId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Look up by composio connection id — used by the OAuth callback. */
export async function findByComposioId(composioConnectionId: string) {
  const row = await convex().query(api.integrations.connections.findByComposioId, {
    composioConnectionId,
  });
  return (row ?? null) as IntegrationConnectionRow | null;
}

/** Look up by our own row id. */
export async function getById(id: string) {
  const row = await convex().query(api.integrations.connections.getById, { id });
  return (row ?? null) as IntegrationConnectionRow | null;
}

/**
 * Upsert by `composioConnectionId`. Used by the OAuth callback now that
 * the connect-route persists the row at initiate-time. If the row exists,
 * update its label (Composio surfaces the connected user's email after
 * OAuth completes) and bump status back to 'active' if it had drifted.
 * If it doesn't exist (callback ran but connect-route didn't persist for
 * some reason — defensive), insert it.
 */
export async function upsertByComposioId(args: {
  spaceId: string;
  userId: string;
  toolkit: string;
  composioConnectionId: string;
  label?: string;
  /** Status to land on. The callback passes 'active' only when Composio's
   *  fetched account status confirms ACTIVE; unconfirmed accounts stay
   *  'pending' so the chat agent never loads tools for a half-finished
   *  OAuth (which 401s and reads as "Cola lost my integrations"). */
  status?: 'active' | 'pending';
}): Promise<IntegrationConnectionRow | null> {
  const targetStatus = args.status ?? 'active';
  try {
    const row = await convex().mutation(api.integrations.connections.upsertByComposioId, {
      spaceId: args.spaceId,
      userId: args.userId,
      toolkit: args.toolkit,
      composioConnectionId: args.composioConnectionId,
      ...(args.label !== undefined ? { label: args.label } : {}),
      status: targetStatus,
    });
    return (row ?? null) as IntegrationConnectionRow | null;
  } catch (err) {
    logger.error('[integrations.connections] upsertByComposioId failed', {
      composioConnectionId: args.composioConnectionId,
      errMessage: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Insert a new connection row. Caller is responsible for revoking any
 * prior active row for the same (space, user, toolkit) BEFORE calling
 * this — the unique-active index will reject otherwise.
 */
export async function insertConnection(args: {
  spaceId: string;
  userId: string;
  toolkit: string;
  composioConnectionId: string;
  label?: string;
  /** Defaults to 'active' (native integrations, reconcile backfills of
   *  Composio-confirmed accounts). The OAuth connect route passes 'pending'
   *  so a row exists from initiate-time WITHOUT the chat agent loading tools
   *  for an unfinished connection. */
  status?: 'active' | 'pending';
  /** Encrypted credential for native integrations (e.g. a Follow Up Boss
   *  API key). Omit for Composio-backed connections. */
  secretCiphertext?: string;
}): Promise<IntegrationConnectionRow | null> {
  try {
    const row = await convex().mutation(api.integrations.connections.insert, {
      spaceId: args.spaceId,
      userId: args.userId,
      toolkit: args.toolkit,
      composioConnectionId: args.composioConnectionId,
      ...(args.label !== undefined ? { label: args.label } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.secretCiphertext ? { secretCiphertext: args.secretCiphertext } : {}),
    });
    return row as IntegrationConnectionRow;
  } catch (err) {
    logger.error('[integrations.connections] insert failed', {
      spaceId: args.spaceId,
      userId: args.userId,
      toolkit: args.toolkit,
      composioConnectionId: args.composioConnectionId,
      hasLabel: Boolean(args.label),
      errMessage: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Flip a row's status. Used for reconnect (prior → revoked) and on errors. */
export async function setStatus(args: {
  id: string;
  status: IntegrationStatus;
  lastError?: string;
}): Promise<void> {
  try {
    await convex().mutation(api.integrations.connections.setStatus, {
      id: args.id,
      status: args.status,
      ...(args.lastError !== undefined ? { lastError: args.lastError } : {}),
    });
  } catch (err) {
    logger.warn('[integrations.connections] setStatus failed', {
      id: args.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Revoke at Composio AND mark our row revoked. Idempotent.
 *
 * Order matters:
 *   1. Trigger subscriptions go FIRST — otherwise Composio keeps
 *      delivering webhooks for a connection we no longer track, the
 *      receiver finds no IntegrationTrigger row, and the deliveries
 *      become permanent noise (plus billable on Composio's side).
 *   2. Then the connection itself.
 *   3. Then our row status.
 *
 * The trigger cleanup is its own best-effort path — a Composio outage
 * deleting one trigger doesn't block deleting the connection. Triggers
 * we can't delete now will become orphans on Composio's side, but
 * disconnect on our side still completes.
 */
export async function revoke(row: IntegrationConnectionRow): Promise<void> {
  // Lazy import — connections.ts ← triggers.ts ← connections.ts (via the
  // IntegrationConnectionRow type re-export) would otherwise be a cycle.
  const { deleteForConnection } = await import('./triggers');
  await deleteForConnection(row.id);
  await composioDelete(row.composioConnectionId);
  await setStatus({ id: row.id, status: 'revoked' });
}

/**
 * Flip the row matching this Composio connection id to 'expired'. Used by
 * the chat agent when the SDK reports the connected account is gone or
 * unauthorized — typically because the seller revoked our OAuth grant on
 * the provider's side. Reflects truth on the integrations panel (amber
 * dot + "Reconnect") the moment we discover the drift; no toast, no
 * notification, just the page being honest the next time they look.
 *
 * Idempotent: a no-op if no row matches (the connection may have been
 * deleted on our side already).
 */
export async function markExpiredByComposioId(
  composioConnectionId: string,
  error: unknown,
): Promise<void> {
  const row = await findByComposioId(composioConnectionId);
  if (!row) return;
  // Don't downgrade an already-revoked or already-expired row — the
  // seller's already seen the truth, and a chat-time write would be
  // pure churn.
  if (row.status === 'revoked' || row.status === 'expired') return;
  const message = error instanceof Error ? error.message : String(error);
  await setStatus({ id: row.id, status: 'expired', lastError: message });
  logger.info('[integrations.connections] marked expired from chat', {
    id: row.id,
    composioConnectionId,
    err: message,
  });
}

/**
 * Same as `markExpiredByComposioId` but keyed by (space, user, toolkit) —
 * the chat agent's catch path knows the toolkit it tried to load tools
 * for, but not necessarily the Composio connected-account id (the SDK
 * doesn't always surface it on the error). Idempotent.
 */
export async function markExpiredByToolkit(args: {
  spaceId: string;
  userId: string;
  toolkit: string;
  error: unknown;
}): Promise<void> {
  const row = await findActive({
    spaceId: args.spaceId,
    userId: args.userId,
    toolkit: args.toolkit,
  });
  if (!row) return;
  const message = args.error instanceof Error ? args.error.message : String(args.error);
  await setStatus({ id: row.id, status: 'expired', lastError: message });
  logger.info('[integrations.connections] marked expired from chat', {
    id: row.id,
    toolkit: args.toolkit,
    err: message,
  });
}

/** Find any active row for this (space, user, toolkit). Helper for callback. */
export async function findActive(args: {
  spaceId: string;
  userId: string;
  toolkit: string;
}): Promise<IntegrationConnectionRow | null> {
  const row = await convex().query(api.integrations.connections.findActive, {
    spaceId: args.spaceId,
    userId: args.userId,
    toolkit: args.toolkit,
  });
  return (row ?? null) as IntegrationConnectionRow | null;
}

/** Pending rows for this (space, user, toolkit) — unfinished OAuth initiations.
 *  The connect route sweeps these before starting a fresh flow so retries
 *  don't accumulate orphans. */
export async function findPending(args: {
  spaceId: string;
  userId: string;
  toolkit: string;
}): Promise<IntegrationConnectionRow[]> {
  const rows = await convex().query(api.integrations.connections.findPending, {
    spaceId: args.spaceId,
    userId: args.userId,
    toolkit: args.toolkit,
  });
  return rows as IntegrationConnectionRow[];
}
