/**
 * POST /api/manager/integrations/connect/[toolkit]
 *
 * Initiate an OAuth connection for the calling manager (owner/admin) + the
 * given toolkit, scoped to the COMPANY rather than their personal seller
 * workspace. Returns the URL the manager's browser should redirect to so
 * Composio can run the auth flow. After approval, Composio sends them back to
 * /integrations/callback/company with the connected-account id.
 *
 * TIERED: gated via requireManager() + canEditSettings(role) — owner/admin
 * only. A seller_member can't reach a manager context, so this 403s for them.
 *
 * Mirrors the seller connect route (app/api/integrations/connect/[toolkit]):
 * we persist the row HERE at initiate-time using Composio's `request.id`, so
 * the connection survives a dropped OAuth round-trip. Only the storage table
 * and scoping (companyId + this manager's userId) differ. The Composio
 * plumbing (initiateConnection) is shared, not forked.
 *
 * Composio scopes connections per "entity". We use the company-namespaced
 * entity id `company:<companyId>:<userId>` so a manager's company-level
 * Gmail is a DISTINCT Composio connection from their personal seller Gmail
 * (which uses the bare Clerk userId as the entity).
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requireManager, canEditSettings } from '@/lib/permissions';
import { COMING_SOON_TOOLKITS, findIntegration } from '@/lib/integrations/catalog';
import { initiateConnection } from '@/lib/integrations/composio';
import {
  findActiveCompanyConnection,
  insertCompanyConnection,
  revokeCompanyConnection,
} from '@/lib/integrations/company-connections';
import { companyEntityId } from '@/lib/integrations/company-entity';
import { logger } from '@/lib/logger';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ toolkit: string }> },
) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let ctx;
  try {
    ctx = await requireManager();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!canEditSettings(ctx.membership.role)) {
    return NextResponse.json(
      { error: 'Only the company owner or admins can connect integrations' },
      { status: 403 },
    );
  }

  const { toolkit } = await params;
  const app = findIntegration(toolkit);
  if (!app) {
    return NextResponse.json({ error: `Unknown integration: ${toolkit}` }, { status: 404 });
  }

  if (COMING_SOON_TOOLKITS.has(toolkit)) {
    return NextResponse.json(
      { error: `${app.name} support is in progress. We will let you know when it lands.` },
      { status: 501 },
    );
  }

  const companyId = ctx.company.id;
  const entityId = companyEntityId({ companyId, userId: clerkId });

  // Reconnect is the manager explicitly choosing a fresh auth — revoke any
  // existing active row for this combo first so the unique-active index stays
  // clean.
  const existing = await findActiveCompanyConnection({
    companyId,
    userId: clerkId,
    toolkit,
  });
  if (existing) {
    await revokeCompanyConnection(existing);
  }

  const callbackUrl = companyCallbackUrl();

  try {
    const request = await initiateConnection({ entityId, toolkit, callbackUrl });

    const inserted = await insertCompanyConnection({
      companyId,
      userId: clerkId,
      toolkit,
      composioConnectionId: request.id,
    });
    if (!inserted) {
      logger.error('[manager.integrations.connect] persist-at-connect failed', {
        companyId,
        userId: clerkId,
        toolkit,
        composioConnectionId: request.id,
      });
      return NextResponse.json(
        { error: `Could not save the ${app.name} connection. Try again.` },
        { status: 500 },
      );
    }

    return NextResponse.json({
      redirectUrl: request.redirectUrl,
      connectionId: request.id,
      toolkit,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[manager.integrations.connect] initiate failed', {
      companyId,
      userId: clerkId,
      toolkit,
      err: message,
    });
    const isActionable = message.startsWith('No Auth Config');
    const surfaced = isActionable
      ? message
      : `Could not start ${app.name} connect. Try again in a moment.`;
    return NextResponse.json({ error: surfaced }, { status: 502 });
  }
}

/**
 * The URL Composio sends the manager to after OAuth completes. Distinct from
 * the seller callback (`/integrations/callback`) so the callback handler
 * knows to persist into the company table, not the seller one.
 */
function companyCallbackUrl(): string | undefined {
  const base = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (!base) {
    logger.error(
      '[manager.integrations.connect] NEXT_PUBLIC_APP_URL is not set — Composio will redirect to its default URL after OAuth, not back to this app.',
    );
    return undefined;
  }
  return `${base.replace(/\/$/, '')}/integrations/callback/company`;
}
