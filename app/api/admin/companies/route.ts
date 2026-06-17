import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit } from '@/lib/rate-limit';
import { auth } from '@clerk/nextjs/server';

/** GET /api/admin/companies — list all companies with owner info and member counts */
export async function GET() {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const session = await auth();
  const { allowed } = await checkRateLimit(`admin:read:${session.userId}`, 60, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  let companies;
  try {
    companies = await convex().query(api.org.companies.listAll, {});
  } catch (error) {
    console.error('[admin/companies] query failed', error);
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }

  // Compose the owner embed lib-side (the old PostgREST User!ownerId join).
  const ownerIds = Array.from(new Set(companies.map((c) => c.ownerId)));
  const owners = ownerIds.length > 0
    ? await convex().query(api.org.users.listByIds, { ids: ownerIds })
    : [];
  const ownerMap = new Map(owners.map((u) => [u.id, { id: u.id, name: u.name, email: u.email }]));

  // Attach member counts
  const ids = companies.map((c) => c.id);
  const memberships = ids.length > 0
    ? await convex().query(api.org.memberships.listByCompanyIds, { companyIds: ids })
    : [];

  const countMap: Record<string, number> = {};
  for (const m of memberships) {
    countMap[m.companyId] = (countMap[m.companyId] ?? 0) + 1;
  }

  const result = companies.map((c) => ({
    ...c,
    User: ownerMap.get(c.ownerId) ?? null,
    memberCount: countMap[c.id] ?? 0,
  }));

  return NextResponse.json({ companies: result });
}
