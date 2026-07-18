import { NextResponse } from 'next/server';
import { requireManager } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';

/**
 * GET /api/manager/leads/export
 * Export all leads across the company as a CSV download.
 * Auth: manager_owner / manager_admin only.
 */
export async function GET() {
  let ctx;
  try {
    ctx = await requireManager();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { company } = ctx;

  // ── Fetch all member user IDs ──────────────────────────────────────────
  let memberships: Array<{ userId: string }> = [];
  try {
    memberships = await convex().query(api.org.memberships.listByCompany, {
      companyId: company.id,
    });
  } catch {
    memberships = [];
  }

  const memberUserIds = (memberships ?? []).map((m: { userId: string }) => m.userId);

  if (memberUserIds.length === 0) {
    const csv = 'Name,Email,Phone,Lead Type,Budget,Score,Score Label,Status,Product Address,Notes,Move-in Date,Employment,Income,Assigned To,Created At\n';
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="leads_export_${new Date().toISOString().split('T')[0]}.csv"`,
      },
    });
  }

  // ── Get spaces owned by members + user profiles in parallel ───────────
  const [spaces, users] = await Promise.all([
    convex()
      .query(api.workspace.spaces.listByOwnerIds, { ownerIds: memberUserIds })
      .catch(() => [] as Array<{ id: string; ownerId: string }>),
    convex()
      .query(api.org.users.listByIds, { ids: memberUserIds })
      .catch(() => [] as Array<{ id: string; name: string | null; email: string }>),
  ]);

  const spaceIds = spaces.map((s) => s.id);
  if (spaceIds.length === 0) {
    const csv = 'Name,Email,Phone,Lead Type,Budget,Score,Score Label,Status,Product Address,Notes,Move-in Date,Employment,Income,Assigned To,Created At\n';
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="leads_export_${new Date().toISOString().split('T')[0]}.csv"`,
      },
    });
  }

  // Build lookup: spaceId -> member name
  const userMap = new Map(
    (users ?? []).map((u: { id: string; name: string | null; email: string }) => [u.id, u]),
  );
  const spaceToMember: Record<string, string> = {};
  for (const sp of spaces) {
    const u = userMap.get(sp.ownerId);
    spaceToMember[sp.id] = u?.name ?? u?.email ?? 'Unknown';
  }

  // ── Fetch all contacts from member spaces ──────────────────────────────
  let contacts;
  try {
    contacts = await convex().query(api.contacts.contacts.filterForSpaces, {
      spaceIds,
      limit: 10000,
    });
  } catch (error) {
    console.error('[manager/leads/export] query error', error);
    return NextResponse.json({ error: 'Failed to fetch leads' }, { status: 500 });
  }

  const rows = (contacts ?? []) as Array<Record<string, unknown>>;

  // ── Build CSV ──────────────────────────────────────────────────────────
  const headers = [
    'Name',
    'Email',
    'Phone',
    'Lead Type',
    'Budget',
    'Score',
    'Score Label',
    'Status',
    'Product Address',
    'Notes',
    'Move-in Date',
    'Employment',
    'Income',
    'Assigned To',
    'Created At',
  ];

  const csvRows = rows.map((c: Record<string, unknown>) => {
    const appData = (c.applicationData ?? {}) as Record<string, unknown>;
    const moveIn = appData.moveInDate ?? appData.move_in_date ?? '';
    const employment = appData.employment ?? appData.employmentStatus ?? '';
    const income = appData.income ?? appData.monthlyIncome ?? appData.annualIncome ?? '';

    return [
      csvEscape(String(c.name ?? '')),
      csvEscape(String(c.email ?? '')),
      csvEscape(String(c.phone ?? '')),
      csvEscape(String(c.leadType ?? '')),
      csvEscape(String(c.budget ?? '')),
      csvEscape(String(c.leadScore ?? '')),
      csvEscape(String(c.scoreLabel ?? '')),
      csvEscape(String(c.scoringStatus ?? '')),
      csvEscape(String(c.address ?? '')),
      csvEscape(String(c.notes ?? '')),
      csvEscape(String(moveIn)),
      csvEscape(String(employment)),
      csvEscape(String(income)),
      csvEscape(spaceToMember[c.spaceId as string] ?? ''),
      csvEscape(c.createdAt ? new Date(c.createdAt as string).toISOString() : ''),
    ].join(',');
  });

  const csv = [headers.join(','), ...csvRows].join('\n');
  const filename = `${company.name.replace(/[^a-zA-Z0-9]/g, '_')}_leads_export_${new Date().toISOString().split('T')[0]}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

function csvEscape(val: string): string {
  const escaped = val.replace(/"/g, '""');
  // Prevent CSV formula injection: prefix with single quote inside quotes
  if (/^[=+\-@\t\r]/.test(escaped)) {
    return `"'${escaped}"`;
  }
  if (escaped.includes(',') || escaped.includes('"') || escaped.includes('\n')) {
    return `"${escaped}"`;
  }
  return escaped;
}
