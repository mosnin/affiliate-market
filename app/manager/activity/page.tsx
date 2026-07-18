import { redirect } from 'next/navigation';
import { getManagerContext } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { ActivityClient, type ActivityRow } from './activity-client';

// Server component: fetch the first page of AuditLog rows scoped to this
// company, then hand off to the client for filter/pagination. Mirrors the
// pattern used by app/manager/reviews/page.tsx — use getManagerContext (not
// requireManager) so non-managers get a clean redirect instead of a 500.
export default async function ManagerActivityPage() {
  const ctx = await getManagerContext();
  if (!ctx) redirect('/');

  // 1. Resolve company spaces.
  const spaceRows = (await convex().query(api.workspace.spaces.listByCompanyId, {
    companyId: ctx.company.id,
  })) as Array<{ id: string; slug: string | null }>;
  const spaces = spaceRows;
  const spaceIds = spaces.map((s) => s.id);
  const spaceMap: Record<string, { slug: string | null }> = {};
  for (const s of spaces) spaceMap[s.id] = { slug: s.slug };

  // 2. Pull the first page — most-recent 100 rows inside the 90-day window.
  //    Same two-query strategy as the API route: space-scoped + explicitly
  //    company-tagged null-space rows, merged and trimmed. See the route
  //    comment for the leak vector this is avoiding.
  const sinceIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const PAGE = 100;

  type AuditLogRow = {
    id: string;
    clerkId: string | null;
    ipAddress: string | null;
    action: string;
    resource: string;
    resourceId: string | null;
    spaceId: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  };

  let spaceScoped: AuditLogRow[] = [];
  if (spaceIds.length > 0) {
    spaceScoped = (await convex().query(api.infra.auditLog.listForSpacesScoped, {
      spaceIds,
      since: sinceIso,
      limit: PAGE + 1,
    })) as AuditLogRow[];
  }

  let nullSpace: AuditLogRow[] = [];
  {
    nullSpace = (await convex().query(api.infra.auditLog.listNullSpaceForCompany, {
      companyId: ctx.company.id,
      since: sinceIso,
      limit: PAGE + 1,
    })) as AuditLogRow[];
  }

  // Stable sort: createdAt desc, then id desc. Matches the route.
  const merged = [...spaceScoped, ...nullSpace].sort((a, b) => {
    const delta = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (delta !== 0) return delta;
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });
  const hasMore = merged.length > PAGE;
  const pageRows = merged.slice(0, PAGE);
  const lastRow = pageRows[pageRows.length - 1];
  // Compound cursor (createdAt|id) — fixes the millisecond-tie bug the
  // audit flagged. Client treats this as an opaque string and echoes it
  // back on the next fetch.
  const nextCursor = hasMore && lastRow ? `${lastRow.createdAt}|${lastRow.id}` : null;

  // 3. Batch-load actor names for the rows we're about to render.
  const clerkIds = Array.from(
    new Set(pageRows.map((r) => r.clerkId).filter((v): v is string => !!v)),
  );
  const actorMap: Record<string, { name: string | null; email: string | null }> = {};
  if (clerkIds.length > 0) {
    // No batch-by-clerkId Convex fn exists; fan out the per-clerkId getByClerkId
    // point reads for the (small) set of actors actually on this page.
    const users = await Promise.all(
      clerkIds.map((clerkId) =>
        convex().query(api.org.users.getByClerkId, { clerkId }),
      ),
    );
    for (const u of users) {
      if (u) actorMap[u.clerkId] = { name: u.name, email: u.email };
    }
  }

  const initialRows: ActivityRow[] = pageRows.map((r) => ({
    id: r.id,
    clerkId: r.clerkId,
    ipAddress: r.ipAddress,
    action: r.action,
    resource: r.resource,
    resourceId: r.resourceId,
    spaceId: r.spaceId,
    metadata: r.metadata,
    createdAt: r.createdAt,
    actor: r.clerkId ? actorMap[r.clerkId] ?? null : null,
    space: r.spaceId ? spaceMap[r.spaceId] ?? null : null,
  }));

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      <header className="space-y-1.5">
        <p className="text-sm text-muted-foreground">Activity.</p>
        <h1
          className="text-3xl tracking-tight text-foreground"
          style={{ fontFamily: 'var(--font-title)' }}
        >
          What the team&apos;s been doing
        </h1>
        <p className="text-sm text-muted-foreground">
          Every action across your company, newest first.
        </p>
      </header>
      <ActivityClient
        initialRows={initialRows}
        initialCursor={nextCursor}
        actors={actorMap}
        spaceMap={spaceMap}
        role={ctx.membership.role}
      />
    </div>
  );
}
