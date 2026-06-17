/**
 * GET /api/cola/approvals
 *
 * Returns the list of AgentTask rows that are paused awaiting human
 * approval, for the caller's space. Mirrors the query that powers
 * `/s/[slug]/cola/approvals/page.tsx` so the slide-over pill in the
 * Cola header can render the same data without a route change.
 *
 * Response: { count: number, tasks: ApprovalTask[] }
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';
import { convex, api } from '@/lib/convex-server';

export interface ApprovalTask {
  id: string;
  spaceId: string;
  title: string;
  goalDescription: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export async function GET() {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ count: 0, tasks: [] });

  let rows: Array<{
    id: string;
    spaceId: string;
    title: string;
    goalDescription: string | null;
    status: string;
    metadata: unknown;
    createdAt: string;
    updatedAt: string;
  }>;
  try {
    rows = await convex().query(api.agent.tasks.listPendingApprovals, {
      spaceId: space.id,
      limit: 50,
    });
  } catch (err) {
    console.error('[api/cola/approvals] query error:', err);
    return NextResponse.json({ error: 'Could not load approvals' }, { status: 500 });
  }

  const tasks: ApprovalTask[] = rows.map((t) => ({
    id: t.id,
    spaceId: t.spaceId,
    title: t.title,
    goalDescription: t.goalDescription,
    status: t.status,
    metadata: t.metadata as Record<string, unknown> | null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));
  return NextResponse.json({ count: tasks.length, tasks });
}
