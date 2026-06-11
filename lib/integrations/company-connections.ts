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

import { supabase } from '@/lib/supabase';
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
  const { data, error } = await supabase
    .from('CompanyIntegrationConnection')
    .select('*')
    .eq('companyId', companyId)
    .order('createdAt', { ascending: false });
  if (error) {
    logger.warn('[integrations.company-connections] list failed', {
      companyId,
      err: error.message,
    });
    return [];
  }
  return (data ?? []) as CompanyIntegrationConnectionRow[];
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
  const { data, error } = await supabase
    .from('CompanyIntegrationConnection')
    .select('*')
    .eq('companyId', args.companyId)
    .eq('userId', args.userId)
    .order('createdAt', { ascending: false });
  if (error) {
    logger.warn('[integrations.company-connections] listForUser failed', {
      companyId: args.companyId,
      err: error.message,
    });
    return [];
  }
  return (data ?? []) as CompanyIntegrationConnectionRow[];
}

/** Look up by composio connection id — used by the OAuth callback. */
export async function findCompanyByComposioId(composioConnectionId: string) {
  const { data } = await supabase
    .from('CompanyIntegrationConnection')
    .select('*')
    .eq('composioConnectionId', composioConnectionId)
    .maybeSingle();
  return (data ?? null) as CompanyIntegrationConnectionRow | null;
}

/** Look up by our own row id. */
export async function getCompanyConnectionById(id: string) {
  const { data } = await supabase
    .from('CompanyIntegrationConnection')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  return (data ?? null) as CompanyIntegrationConnectionRow | null;
}

/** Find any active row for this (company, user, toolkit). */
export async function findActiveCompanyConnection(args: {
  companyId: string;
  userId: string;
  toolkit: string;
}): Promise<CompanyIntegrationConnectionRow | null> {
  const { data } = await supabase
    .from('CompanyIntegrationConnection')
    .select('*')
    .eq('companyId', args.companyId)
    .eq('userId', args.userId)
    .eq('toolkit', args.toolkit)
    .eq('status', 'active')
    .maybeSingle();
  return (data ?? null) as CompanyIntegrationConnectionRow | null;
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
  const { data, error } = await supabase
    .from('CompanyIntegrationConnection')
    .insert({
      companyId: args.companyId,
      userId: args.userId,
      toolkit: args.toolkit,
      composioConnectionId: args.composioConnectionId,
      label: args.label ?? null,
      status: 'active',
    })
    .select('*')
    .single();
  if (error) {
    logger.error('[integrations.company-connections] insert failed', {
      companyId: args.companyId,
      userId: args.userId,
      toolkit: args.toolkit,
      composioConnectionId: args.composioConnectionId,
      hasLabel: Boolean(args.label),
      errCode: (error as { code?: string }).code ?? null,
      errMessage: error.message,
      errDetails: (error as { details?: string }).details ?? null,
      errHint: (error as { hint?: string }).hint ?? null,
    });
    return null;
  }
  return data as CompanyIntegrationConnectionRow;
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
  const existing = await findCompanyByComposioId(args.composioConnectionId);
  if (existing) {
    const { error } = await supabase
      .from('CompanyIntegrationConnection')
      .update({
        label: args.label ?? existing.label ?? null,
        status: 'active',
        lastError: null,
        updatedAt: new Date().toISOString(),
      })
      .eq('id', existing.id);
    if (error) {
      logger.error('[integrations.company-connections] upsertByComposioId update failed', {
        id: existing.id,
        errCode: (error as { code?: string }).code ?? null,
        errMessage: error.message,
      });
      return null;
    }
    return {
      ...existing,
      label: args.label ?? existing.label ?? null,
      status: 'active',
      lastError: null,
    };
  }
  return insertCompanyConnection(args);
}

/** Flip a row's status. Used for reconnect (prior → revoked) and on errors. */
export async function setCompanyConnectionStatus(args: {
  id: string;
  status: CompanyIntegrationStatus;
  lastError?: string;
}): Promise<void> {
  const { error } = await supabase
    .from('CompanyIntegrationConnection')
    .update({
      status: args.status,
      lastError: args.lastError ?? null,
      updatedAt: new Date().toISOString(),
    })
    .eq('id', args.id);
  if (error) {
    logger.warn('[integrations.company-connections] setStatus failed', {
      id: args.id,
      err: error.message,
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
