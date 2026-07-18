import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit } from '@/lib/rate-limit';
import { auth } from '@clerk/nextjs/server';

/** GET /api/admin/invitations — list all invitations across all companies */
export async function GET() {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const session = await auth();
  const { allowed } = await checkRateLimit(`admin:read:${session.userId}`, 60, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  let rows;
  try {
    rows = await convex().query(api.org.invitations.listAll, { limit: 200 });
  } catch (error) {
    console.error('[admin/invitations] query failed', error);
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }

  // Compose the Company(name) embed lib-side (the old PostgREST join) and project
  // to the exact column set the old query selected (notably WITHOUT the token).
  const companyIds = Array.from(new Set(rows.map((i) => i.companyId)));
  const companies = companyIds.length > 0
    ? await convex().query(api.org.companies.listByIds, { ids: companyIds })
    : [];
  const nameMap = new Map(companies.map((c) => [c.id, c.name]));

  const invitations = rows.map((i) => ({
    id: i.id,
    email: i.email,
    roleToAssign: i.roleToAssign,
    status: i.status,
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
    companyId: i.companyId,
    Company: { name: nameMap.get(i.companyId) ?? null },
  }));

  return NextResponse.json({ invitations });
}
