import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
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
  const { data: spaces } = await supabase
    .from('Space')
    .select('id, name, ownerId')
    .or(`companyId.eq.${companyId},ownerId.eq.${ownerId}`)
    .limit(2000);
  const rows = (spaces ?? []) as { id: string; name: string; ownerId: string }[];
  if (rows.length === 0) return [];

  const ownerIds = Array.from(new Set(rows.map((r) => r.ownerId)));
  const { data: users } = await supabase.from('User').select('id, name').in('id', ownerIds);
  const nameById = new Map((users ?? []).map((u) => [u.id as string, u.name as string | null]));

  return rows.map((r) => ({ id: r.id, name: r.name, ownerName: nameById.get(r.ownerId) ?? null }));
}

export async function GET() {
  const ctx = await resolveManagerContext();
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const members = await loadMemberSpaces(ctx.company.id, ctx.company.ownerId);

  const { data, error } = await supabase
    .from('Product')
    .select('*')
    .eq('companyId', ctx.company.id)
    .order('updatedAt', { ascending: false })
    .limit(2000);
  if (error) {
    logger.error('[manager/products/GET] query failed', { companyId: ctx.company.id }, error);
    return NextResponse.json({ error: 'Failed to fetch products' }, { status: 500 });
  }

  return NextResponse.json({ products: data ?? [], members });
}

export async function POST(req: NextRequest) {
  const ctx = await resolveManagerContext();
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  // The pool's home Space — the manager owner's. Required because Product.spaceId
  // is NOT NULL. A manager with no personal Space can't seed the pool yet.
  const { data: ownerSpace } = await supabase
    .from('Space')
    .select('id')
    .eq('ownerId', ctx.company.ownerId)
    .maybeSingle();
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

  const insert = {
    id: crypto.randomUUID(),
    spaceId: ownerSpace.id as string,
    companyId: ctx.company.id,
    assignedSpaceId,
    listingStatus: out.listingStatus ?? 'active',
    photos: out.photos ?? [],
    ...out,
  };

  const { data, error } = await supabase.from('Product').insert(insert).select().single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'A product with that MLS number already exists' }, { status: 409 });
    }
    logger.error('[manager/products/POST] insert failed', { companyId: ctx.company.id }, error);
    return NextResponse.json({ error: 'Failed to create product' }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
