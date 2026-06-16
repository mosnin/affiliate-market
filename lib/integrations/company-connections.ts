/**
 * DB-side helpers for CompanyIntegrationConnection rows — the company
 * analogue of connections.ts. Composio holds the OAuth tokens; this table
 * holds the pointer + status + audit. One active row per
 * (company, user, toolkit) — a reconnect flips the prior row to 'revoked'
 * and inserts a new 'active' row.
 *
 * Scoped by companyId + the Clerk userId of the admin/owner who connected,
 * so two admins can each connect their OWN Gmail at the company level
 * without colliding. The Composio plumbing (initiate / get / delete) is NOT
 * forked — it lives in composio.ts and is shared with the seller flow. Only
 * storage and scoping differ here.
 */

import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { deleteConnection as composioDelete } from './composio';

export type CompanyIntegrationStatus = 'active' | 'expired' | 'revoked' | 'failed';

export interface CompanyIntegrationConnectionRow {
  id: string;
  companyId: string;
  userId: string;
  toolkit: string;
  composioConnectionId: string;
  status: CompanyIntegrationStatus;
  label: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** All connections for a company, regardless of status. UI filters as needed. */
export async function listCompanyConnections(
  companyId: string,
): Promise<CompanyIntegrationConnectionRow[]> {
  try {
    const rows = await convex().query(api.integrations.companyConnections.listByCompany, {
      companyId,
    });
    return rows as CompanyIntegrationConnectionRow[];
  } catch (err) {
    logger.warn('[integrations.company-connections] list failed', {
      companyId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Connections for a single (company, user). The company integrations
 * panel shows each admin only their OWN connected accounts — they connect
 * with their own OAuth grants, so they manage their own rows.
 */
export async function listCompanyConnectionsForUser(args: {
  companyId: string;
  userId: string;
}): Promise<CompanyIntegrationConnectionRow[]> {
  try {
    const rows = await convex().query(api.integrations.companyConnections.listByCompanyUser, {
      companyId: args.companyId,
      userId: args.userId,
    });
    return rows as CompanyIntegrationConnectionRow[];
  } catch (err) {
    logger.warn('[integrations.company-connections] listForUser failed', {
      companyId: args.companyId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Look up by composio connection id — used by the OAuth callback. */
export async function findCompanyByComposioId(composioConnectionId: string) {
  const row = await convex().query(api.integrations.companyConnections.findByComposioId, {
    composioConnectionId,
  });
  return (row ?? null) as CompanyIntegrationConnectionRow | null;
}

/** Look up by our own row id. */
export async function getCompanyConnectionById(id: string) {
  const row = await convex().query(api.integrations.companyConnections.getById, { id });
  return (row ?? null) as CompanyIntegrationConnectionRow | null;
}

/** Find any active row for this (company, user, toolkit). */
export async function findActiveCompanyConnection(args: {
  companyId: string;
  userId: string;
  toolkit: string;
}): Promise<CompanyIntegrationConnectionRow | null> {
  const row = await convex().query(api.integrations.companyConnections.findActive, {
    companyId: args.companyId,
    userId: args.userId,
    toolkit: args.toolkit,
  });
  return (row ?? null) as CompanyIntegrationConnectionRow | null;
}

/**
 * Insert a new connection row. Caller is responsible for revoking any prior
 * active row for the same (company, user, toolkit) BEFORE calling this —
 * the unique-active index will reject otherwise.
 */
export async function insertCompanyConnection(args: {
  companyId: string;
  userId: string;
  toolkit: string;
  composioConnectionId: string;
  label?: string;
}): Promise<CompanyIntegrationConnectionRow | null> {
  try {
    const row = await convex().mutation(api.integrations.companyConnections.insert, {
      companyId: args.companyId,
      userId: args.userId,
      toolkit: args.toolkit,
      composioConnectionId: args.composioConnectionId,
      ...(args.label !== undefined ? { label: args.label } : {}),
    });
    return row as CompanyIntegrationConnectionRow;
  } catch (err) {
    logger.error('[integrations.company-connections] insert failed', {
      companyId: args.companyId,
      userId: args.userId,
      toolkit: args.toolkit,
      composioConnectionId: args.composioConnectionId,
      hasLabel: Boolean(args.label),
      errMessage: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Upsert by `composioConnectionId`. Used by the OAuth callback: the connect
 * route persists the row at initiate-time, so the callback updates the label
 * (Composio surfaces the connected user's email after OAuth completes) and
 * bumps status back to 'active' if it drifted. Falls back to insert if the
 * row somehow doesn't exist.
 */
export async function upsertCompanyByComposioId(args: {
  companyId: string;
  userId: string;
  toolkit: string;
  composioConnectionId: string;
  label?: string;
}): Promise<CompanyIntegrationConnectionRow | null> {
  try {
    const row = await convex().mutation(
      api.integrations.companyConnections.upsertByComposioId,
      {
        companyId: args.companyId,
        userId: args.userId,
        toolkit: args.toolkit,
        composioConnectionId: args.composioConnectionId,
        ...(args.label !== undefined ? { label: args.label } : {}),
      },
    );
    return (row ?? null) as CompanyIntegrationConnectionRow | null;
  } catch (err) {
    logger.error('[integrations.company-connections] upsertByComposioId failed', {
      composioConnectionId: args.composioConnectionId,
      errMessage: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Flip a row's status. Used for reconnect (prior → revoked) and on errors. */
export async function setCompanyConnectionStatus(args: {
  id: string;
  status: CompanyIntegrationStatus;
  lastError?: string;
}): Promise<void> {
  try {
    await convex().mutation(api.integrations.companyConnections.setStatus, {
      id: args.id,
      status: args.status,
      ...(args.lastError !== undefined ? { lastError: args.lastError } : {}),
    });
  } catch (err) {
    logger.warn('[integrations.company-connections] setStatus failed', {
      id: args.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Revoke at Composio AND mark our row revoked. Idempotent. Company-level
 * connections don't register curated triggers (no inbound-event wiring at the
 * company level yet), so this is a straight delete-then-mark — no trigger
 * cleanup step like the seller revoke path.
 */
export async function revokeCompanyConnection(
  row: CompanyIntegrationConnectionRow,
): Promise<void> {
  await composioDelete(row.composioConnectionId);
  await setCompanyConnectionStatus({ id: row.id, status: 'revoked' });
}
