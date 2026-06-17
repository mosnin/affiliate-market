import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requireManager } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { audit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/manager/invitations/[id]
 * Cancel a pending invitation. Available to manager_owner and manager_admin.
 */
export async function PATCH(_req: Request, { params }: Params) {
  const { userId: clerkId } = await auth();
  let ctx;
  try {
    ctx = await requireManager();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id: invitationId } = await params;

  const inv = await convex().query(api.org.invitations.getByIdScoped, {
    id: invitationId,
    companyId: ctx.company.id,
  });

  if (!inv) {
    return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
  }

  if (inv.status !== 'pending') {
    return NextResponse.json({ error: `Cannot cancel an invitation with status: ${inv.status}` }, { status: 409 });
  }

  // Scope the update to companyId as well to prevent a TOCTOU race between
  // the fetch above and this write.
  try {
    await convex().mutation(api.org.invitations.setStatusScoped, {
      id: invitationId,
      companyId: ctx.company.id,
      status: 'cancelled',
    });
  } catch (error) {
    console.error('[manager/invitations/cancel] update failed', error);
    return NextResponse.json({ error: 'Failed to cancel invitation' }, { status: 500 });
  }

  void audit({ actorClerkId: clerkId ?? null, action: 'UPDATE', resource: 'Invitation', resourceId: invitationId, metadata: { status: 'cancelled', companyId: ctx.company.id } });

  return NextResponse.json({ success: true });
}
