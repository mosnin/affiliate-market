import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { getCompanyMembers } from '@/lib/company-members';

/**
 * GET /api/manager/contacts
 *
 * Returns contacts scoped to ALL member spaces in the manager's company,
 * each annotated with `sellerName` (the owning seller's display name).
 *
 * Query params:
 *   search  — optional; case-insensitive substring match on name/email/phone
 *   type    — optional; QUALIFICATION | DEMO | APPLICATION | ALL (default ALL)
 *   limit   — optional; default 500, max 1000
 *   offset  — optional; default 0
 */
export async function GET(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireManager();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { company } = ctx;

  // ── Resolve all member spaces ──────────────────────────────────────────────
  const allMembers = await getCompanyMembers(company.id, {
    includeSpaceName: true,
  });

  const memberSpaceIds = allMembers
    .map((m) => m.Space?.id)
    .filter(Boolean) as string[];

  // Belt-and-suspenders: include owner's own space if memberships resolved empty
  let ownerSpaceIds: string[] = [];
  if (memberSpaceIds.length === 0) {
    let ownerSpace: { id: string } | null = null;
    try {
      ownerSpace = await convex().query(api.workspace.spaces.getByOwnerId, {
        ownerId: company.ownerId,
      });
    } catch {
      ownerSpace = null;
    }
    ownerSpaceIds = ownerSpace ? [ownerSpace.id] : [];
  }

  const spaceIds = [...new Set([...memberSpaceIds, ...ownerSpaceIds])];

  if (spaceIds.length === 0) {
    return NextResponse.json([]);
  }

  // ── Build spaceId → seller display-name map ──────────────────────────────
  const spaceToSeller = new Map<string, string>();
  for (const m of allMembers) {
    const sid = m.Space?.id;
    if (!sid) continue;
    spaceToSeller.set(sid, m.User?.name ?? m.User?.email ?? 'Unknown seller');
  }

  // ── Parse query params ────────────────────────────────────────────────────
  const search = (req.nextUrl.searchParams.get('search') ?? '').trim();
  const type = req.nextUrl.searchParams.get('type') ?? 'ALL';
  const limitParam = parseInt(req.nextUrl.searchParams.get('limit') ?? '500', 10);
  const offsetParam = parseInt(req.nextUrl.searchParams.get('offset') ?? '0', 10);
  const limit = Math.min(Math.max(1, limitParam || 500), 1000);
  const offset = Math.max(0, offsetParam || 0);

  // ── Build query ───────────────────────────────────────────────────────────
  let data;
  try {
    data = await convex().query(api.contacts.contacts.listForSpaces, {
      spaceIds,
      type: type && type !== 'ALL' ? type : undefined,
      search: search || undefined,
      limit,
      offset,
    });
  } catch (error) {
    console.error('[manager/contacts/GET] query error:', error);
    return NextResponse.json({ error: 'Failed to fetch contacts' }, { status: 500 });
  }

  // Annotate each row with sellerName
  const annotated = (data ?? []).map((c: any) => ({
    ...c,
    sellerName: spaceToSeller.get(c.spaceId) ?? 'Unknown seller',
  }));

  return NextResponse.json(annotated);
}
