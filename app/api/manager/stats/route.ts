import { NextResponse } from 'next/server';
import { requireManager } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';

/**
 * GET /api/manager/stats
 * Aggregate counts across all member workspaces for the manager dashboard.
 */
export async function GET() {
  let ctx;
  try {
    ctx = await requireManager();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { company } = ctx;

  // Get all member user ids in this company
  let memberships: Array<{ userId: string }> = [];
  try {
    memberships = await convex().query(api.org.memberships.listByCompany, {
      companyId: company.id,
    });
  } catch {
    memberships = [];
  }
  const memberUserIds = (memberships ?? []).map((m) => m.userId);

  if (memberUserIds.length === 0) {
    return NextResponse.json({ memberCount: 0, totalLeads: 0, totalApplications: 0, pendingInvites: 0 });
  }

  // Get spaces owned by members
  let spaces: Array<{ id: string }> = [];
  try {
    spaces = await convex().query(api.workspace.spaces.listByOwnerIds, {
      ownerIds: memberUserIds,
    });
  } catch {
    spaces = [];
  }
  const spaceIds = (spaces ?? []).map((s) => s.id);

  // Count leads (new-lead tag) and applications across all member spaces
  const [leadsCount, appsCount, pendingCount] = await Promise.all([
    spaceIds.length > 0
      ? convex()
          .query(api.contacts.contacts.countForSpaces, { spaceIds, tagsAll: ['new-lead'] })
          .catch(() => 0)
      : Promise.resolve(0),
    spaceIds.length > 0
      ? convex()
          .query(api.contacts.contacts.countForSpaces, { spaceIds, tagsAll: ['application-link'] })
          .catch(() => 0)
      : Promise.resolve(0),
    convex()
      .query(api.org.invitations.countPending, {
        companyId: company.id,
        now: new Date().toISOString(),
      })
      .catch(() => 0),
  ]);

  return NextResponse.json({
    memberCount: memberUserIds.length,
    totalLeads: leadsCount ?? 0,
    totalApplications: appsCount ?? 0,
    pendingInvites: pendingCount ?? 0,
  });
}
