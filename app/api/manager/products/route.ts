import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { convex, api } from '@/lib/convex-server';
import type { FunctionArgs } from 'convex/server';
import { resolveManagerContext } from '@/lib/agent/manager-context';
import { logger } from '@/lib/logger';
import { _sanitiseProductBody as sanitiseBody } from '@/app/api/products/route';

/**
 * GET /api/manager/products — the company's product pool.
 *
 * Lists every Product tagged with this company (`companyId`), newest
 * first, plus the roster of member spaces so the UI can render the
 * "assign to seller" control and resolve `assignedSpaceId` to a name.
 *
 * POST — create a pool product. It's owned by the manager owner's Space (so
 * the NOT NULL `spaceId` FK holds) and tagged with `companyId`; an optional
 * `assignedSpaceId` assigns it to a member seller on creation.
 *
 * Manager-only gate: `resolveManagerContext()` rejects seller_members.
 */

interface MemberSpace {
  id: string;
  name: string;
  ownerName: string | null;
}

/** The company's member spaces (every seller's Space under the company,
 *  plus the owner's own Space — the pool's home). Used to validate assignment
 *  targets and to label assigned products. */
async function loadMemberSpaces(companyId: string, ownerId: string): Promise<MemberSpace[]> {
  // Reconstruct the old `.or(companyId.eq.X, ownerId.eq.Y)`: every space in the
  // company, UNION the owner's own space (which may not carry companyId yet).
  let spaces: { id: string; name: string; ownerId: string }[] = [];
  try {
    const [companySpaces, ownerSpace] = await Promise.all([
      convex().query(api.workspace.spaces.listByCompanyId, { companyId }),
      convex().query(api.workspace.spaces.getByOwnerId, { ownerId }),
    ]);
    const byId = new Map<string, { id: string; name: string; ownerId: string }>();
    for (const s of companySpaces) byId.set(s.id, { id: s.id, name: s.name, ownerId: s.ownerId });
    if (ownerSpace) byId.set(ownerSpace.id, { id: ownerSpace.id, name: ownerSpace.name, ownerId: ownerSpace.ownerId });
    spaces = Array.from(byId.values());
  } catch {
    spaces = [];
  }
  const rows = spaces;
  if (rows.length === 0) return [];

  const ownerIds = Array.from(new Set(rows.map((r) => r.ownerId)));
  let users: Array<{ id: string; name: string | null }> = [];
  try {
    users = await convex().query(api.org.users.listByIds, { ids: ownerIds });
  } catch {
    users = [];
  }
  const nameById = new Map((users ?? []).map((u) => [u.id as string, u.name as string | null]));

  return rows.map((r) => ({ id: r.id, name: r.name, ownerName: nameById.get(r.ownerId) ?? null }));
}

export async function GET() {
  const ctx = await resolveManagerContext();
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const members = await loadMemberSpaces(ctx.company.id, ctx.company.ownerId);

  let products: Array<Record<string, unknown>>;
  try {
    products = (await convex().query(api.marketplace.products.listForCompany, {
      companyId: ctx.company.id,
    })) as Array<Record<string, unknown>>;
  } catch (error) {
    logger.error('[manager/products/GET] query failed', { companyId: ctx.company.id }, error);
    return NextResponse.json({ error: 'Failed to fetch products' }, { status: 500 });
  }

  return NextResponse.json({ products, members });
}

export async function POST(req: NextRequest) {
  const ctx = await resolveManagerContext();
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  // The pool's home Space — the manager owner's. Required because Product.spaceId
  // is NOT NULL. A manager with no personal Space can't seed the pool yet.
  let ownerSpace: { id: string } | null = null;
  try {
    ownerSpace = await convex().query(api.workspace.spaces.getByOwnerId, {
      ownerId: ctx.company.ownerId,
    });
  } catch {
    ownerSpace = null;
  }
  if (!ownerSpace?.id) {
    return NextResponse.json(
      { error: 'Set up your own workspace before adding pool products.' },
      { status: 409 },
    );
  }

  const { out, errors } = sanitiseBody(body, 'create');
  if (errors.length) return NextResponse.json({ error: errors.join(', ') }, { status: 400 });

  // Optional assignment on create — must be a space in this company.
  let assignedSpaceId: string | null = null;
  if (typeof body.assignedSpaceId === 'string' && body.assignedSpaceId) {
    const members = await loadMemberSpaces(ctx.company.id, ctx.company.ownerId);
    if (!members.some((m) => m.id === body.assignedSpaceId)) {
      return NextResponse.json({ error: 'That seller is not in your company.' }, { status: 400 });
    }
    assignedSpaceId = body.assignedSpaceId;
  }

  // `out` is the sanitised writable bag; companyId/assignedSpaceId are writable
  // columns so they ride in `fields`. spaceId (the pool's home) is a top-level arg.
  const fields = {
    ...out,
    companyId: ctx.company.id,
    assignedSpaceId,
    listingStatus: out.listingStatus ?? 'active',
    photos: out.photos ?? [],
    // `out` is the runtime-sanitised bag; Convex re-validates against
    // writableFields at the boundary, so cast to the create arg shape.
  } as unknown as FunctionArgs<typeof api.marketplace.products.create>['fields'];

  const result = await convex().mutation(api.marketplace.products.create, {
    id: crypto.randomUUID(),
    spaceId: ownerSpace.id as string,
    fields,
  });
  if (!result.ok) {
    if (result.error === 'duplicate_mls' || result.error === 'duplicate_slug') {
      return NextResponse.json({ error: 'A product with that MLS number already exists' }, { status: 409 });
    }
    logger.error('[manager/products/POST] insert failed', { companyId: ctx.company.id, error: result.error });
    return NextResponse.json({ error: 'Failed to create product' }, { status: 500 });
  }

  return NextResponse.json(result.product, { status: 201 });
}
