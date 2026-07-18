import { redirect } from 'next/navigation';
import { getManagerMemberContext } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { AgentActivityClient, type SellerRollup, type ResponseShape } from './agent-activity-client';

const DEFAULT_WINDOW_DAYS = 30;
const ROLLUP_LOG_CAP = 5000;

type Bucket =
  | 'demos'
  | 'stageMoves'
  | 'reviews'
  | 'drafts'
  | 'routedOut'
  | 'routedIn'
  | 'runs';

function bucketFor(actionType: string): Bucket {
  switch (actionType) {
    case 'demo_booked':         return 'demos';
    case 'deal_stage_advanced': return 'stageMoves';
    case 'review_requested':    return 'reviews';
    case 'message_drafted':
    case 'packet_drafted':      return 'drafts';
    case 'lead_routed_out':     return 'routedOut';
    case 'lead_routed_in':      return 'routedIn';
    default:                    return 'runs';
  }
}

function emptyTotals(): SellerRollup['totals'] {
  return {
    all: 0, completed: 0, queued: 0, failed: 0,
    demos: 0, stageMoves: 0, reviews: 0, drafts: 0,
    routedOut: 0, routedIn: 0, runs: 0,
  };
}

// Compute the rollup directly here on the server — saves the API
// round-trip for the initial paint. The client refetches via
// /api/manager/agent-activity when the seller changes the window.
async function rollupForCompany(companyId: string, windowDays: number): Promise<ResponseShape> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const generatedAt = new Date().toISOString();

  const memberships = (await convex().query(api.org.memberships.listByCompany, {
    companyId,
  })) as Array<{ userId: string }>;
  const memberUserIds = memberships.map((m) => m.userId);

  if (memberUserIds.length === 0) {
    return {
      windowDays,
      generatedAt,
      sellers: [],
      company: { totals: emptyTotals(), sellerCount: 0 },
    };
  }

  const spacesData = (await convex().query(api.workspace.spaces.listByOwnerIds, {
    ownerIds: memberUserIds,
  })) as Array<{ id: string; slug: string; ownerId: string }>;
  const spaces = spacesData;
  const spaceIds = spaces.map((s) => s.id);

  if (spaceIds.length === 0) {
    return {
      windowDays,
      generatedAt,
      sellers: [],
      company: { totals: emptyTotals(), sellerCount: 0 },
    };
  }

  const usersData = (await convex().query(api.org.users.listByIds, {
    ids: memberUserIds,
  })) as Array<{ id: string; name: string | null; email: string | null }>;
  const userById = new Map(usersData.map((u) => [u.id, u]));

  const logs = await convex()
    .query(api.agent.activity.rollupForSpaces, {
      spaceIds,
      since,
      limit: ROLLUP_LOG_CAP,
    })
    .catch(() => [] as { spaceId: string; actionType: string; outcome: string; createdAt: string }[]);

  const rollupBySpace = new Map<string, SellerRollup>();
  for (const space of spaces) {
    const user = userById.get(space.ownerId);
    rollupBySpace.set(space.id, {
      userId: space.ownerId,
      name: user?.name ?? null,
      email: user?.email ?? null,
      spaceId: space.id,
      spaceSlug: space.slug,
      totals: emptyTotals(),
      lastActivityAt: null,
    });
  }

  const companyTotals = emptyTotals();

  for (const row of (logs ?? []) as Array<{
    spaceId: string;
    actionType: string;
    outcome: string;
    createdAt: string;
  }>) {
    const r = rollupBySpace.get(row.spaceId);
    if (!r) continue;

    r.totals.all += 1;
    companyTotals.all += 1;

    if (row.outcome === 'completed') { r.totals.completed += 1; companyTotals.completed += 1; }
    else if (row.outcome === 'queued_for_approval') { r.totals.queued += 1; companyTotals.queued += 1; }
    else if (row.outcome === 'failed') { r.totals.failed += 1; companyTotals.failed += 1; }

    const bucket = bucketFor(row.actionType);
    r.totals[bucket] += 1;
    companyTotals[bucket] += 1;

    if (!r.lastActivityAt || row.createdAt > r.lastActivityAt) {
      r.lastActivityAt = row.createdAt;
    }
  }

  const sellers = Array.from(rollupBySpace.values()).sort((a, b) => {
    if (b.totals.all !== a.totals.all) return b.totals.all - a.totals.all;
    const an = (a.name ?? a.email ?? '').toLowerCase();
    const bn = (b.name ?? b.email ?? '').toLowerCase();
    return an.localeCompare(bn);
  });

  return {
    windowDays,
    generatedAt,
    sellers,
    company: { totals: companyTotals, sellerCount: sellers.length },
  };
}

export default async function ManagerAgentActivityPage() {
  const ctx = await getManagerMemberContext();
  if (!ctx) redirect('/');

  const initial = await rollupForCompany(ctx.company.id, DEFAULT_WINDOW_DAYS);

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-56 md:pb-24">
      <header className="space-y-1.5">
        <p className="text-sm text-muted-foreground">Cola.</p>
        <h1
          className="text-3xl tracking-tight text-foreground"
          style={{ fontFamily: 'var(--font-title)' }}
        >
          What Cola did
        </h1>
        <p className="text-sm text-muted-foreground">
          Across {ctx.company.name}. Updates as your team works.
        </p>
      </header>

      <AgentActivityClient initial={initial} companyName={ctx.company.name} />
    </div>
  );
}
