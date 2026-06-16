import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { resolveManagerContext } from '@/lib/agent/manager-context';
import { logger } from '@/lib/logger';

/**
 * PATCH /api/manager/products/[id]/assign — assign a pool product to a member
 * seller (or unassign it).
 *
 * Body: `{ assignedSpaceId: string | null }`. The product must belong to the
 * caller's company; a non-null target must be a Space in that company.
 * Once assigned, the seller sees the product in their own workspace.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await resolveManagerContext();
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { assignedSpaceId?: unknown } | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const target =
    body.assignedSpaceId === null || body.assignedSpaceId === ''
      ? null
      : typeof body.assignedSpaceId === 'string'
        ? body.assignedSpaceId
        : undefined;
  if (target === undefined) {
    return NextResponse.json({ error: 'assignedSpaceId must be a space id or null' }, { status: 400 });
  }

  // The product must be in this company's pool.
  const prop = await convex().query(api.marketplace.products.getById, { id });
  if (!prop || prop.companyId !== ctx.company.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // A non-null target must be a space inside this company (a member's, or
  // the owner's own).
  if (target) {
    const { data: space } = await supabase
      .from('Space')
      .select('id, companyId, ownerId')
      .eq('id', target)
      .maybeSingle();
    const s = space as { companyId?: string; ownerId?: string } | null;
    const inCompany =
      s && (s.companyId === ctx.company.id || s.ownerId === ctx.company.ownerId);
    if (!inCompany) {
      return NextResponse.json({ error: 'That seller is not in your company.' }, { status: 400 });
    }
  }

  const result = await convex().mutation(api.marketplace.products.setAssignedSpace, {
    id,
    assignedSpaceId: target,
  });
  if (!result.ok) {
    logger.error('[manager/products/assign] update failed', { companyId: ctx.company.id, id, error: result.error });
    return NextResponse.json({ error: 'Failed to assign product' }, { status: 500 });
  }

  return NextResponse.json(result.product);
}
