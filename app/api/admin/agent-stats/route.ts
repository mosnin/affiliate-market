import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requirePlatformAdmin } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit } from '@/lib/rate-limit';

/** GET /api/admin/agent-stats — aggregated agentic system metrics for platform admins */
export async function GET(req: Request) {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const session = await auth();
  const { allowed } = await checkRateLimit(`admin:agent-stats:read:${session.userId}`, 60, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const { searchParams } = new URL(req.url);
  const daysParam = searchParams.get('days');
  const days = Math.min(Math.max(1, parseInt(daysParam ?? '30', 10) || 30), 365);

  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    // Tasks created in the window. One Convex scan returns (status,
    // estimatedCostUsd, spaceId) — the superset the four old `.gte('createdAt',
    // since)` reads each pulled a slice of. Folds 1/2/4 run off this single list.
    const taskRows = await convex().query(api.agent.tasks.listSince, { since });

    // ── 1. Task counts by status ──────────────────────────────────────────────
    const tasksByStatus: Record<string, number> = {};
    let totalTasks = 0;
    let failedCount = 0;

    for (const row of taskRows) {
      const s = row.status as string;
      tasksByStatus[s] = (tasksByStatus[s] ?? 0) + 1;
      totalTasks++;
      if (s === 'failed') failedCount++;
    }

    // ── 2. Cost aggregates ────────────────────────────────────────────────────
    let totalCostUsd = 0;
    for (const row of taskRows) {
      totalCostUsd += parseFloat(String(row.estimatedCostUsd ?? 0));
    }
    const avgCostUsd = totalTasks > 0 ? totalCostUsd / totalTasks : 0;

    // ── 3. Top tools by call count (via ExecutionStep) ────────────────────────
    // The old PostgREST `ExecutionStep!inner(AgentTask.createdAt)` join runs
    // inside Convex (both tables are this domain's): toolNames for every step
    // whose parent task was created in the window. The per-tool tally stays here.
    const toolNames = await convex().query(api.agent.steps.toolNamesForTasksSince, { since });

    const toolCounts: Record<string, number> = {};
    for (const name of toolNames) {
      toolCounts[name] = (toolCounts[name] ?? 0) + 1;
    }

    const topTools = Object.entries(toolCounts)
      .map(([name, callCount]) => ({ name, callCount }))
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 10);

    // ── 4. Tasks + cost by space ──────────────────────────────────────────────
    const spaceMap: Record<string, { count: number; cost: number }> = {};
    for (const row of taskRows) {
      const entry = spaceMap[row.spaceId] ?? { count: 0, cost: 0 };
      entry.count++;
      entry.cost += parseFloat(String(row.estimatedCostUsd ?? 0));
      spaceMap[row.spaceId] = entry;
    }

    const tasksBySpace = Object.entries(spaceMap)
      .map(([spaceId, { count, cost }]) => ({ spaceId, count, cost }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // ── 5. Error rate ─────────────────────────────────────────────────────────
    const errorRate = totalTasks > 0 ? (failedCount / totalTasks) * 100 : 0;

    return NextResponse.json({
      days,
      totalTasks,
      tasksByStatus,
      avgCostUsd: parseFloat(avgCostUsd.toFixed(6)),
      totalCostUsd: parseFloat(totalCostUsd.toFixed(6)),
      topTools,
      errorRate: parseFloat(errorRate.toFixed(2)),
      tasksBySpace,
    });
  } catch (err) {
    console.error('[admin/agent-stats] unexpected error', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
