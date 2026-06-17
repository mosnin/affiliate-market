import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requirePlatformAdmin } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit } from '@/lib/rate-limit';
import { logAdminAction } from '@/lib/admin';

type Params = { params: Promise<{ id: string }> };

/**
 * DELETE /api/admin/memberships/[id]
 * Remove a company membership and unlink the user's space from the company.
 */
export async function DELETE(_req: Request, { params }: Params) {
  let admin: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const session = await auth();
  const { allowed } = await checkRateLimit(`admin:${session.userId}`, 30, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const { id } = await params;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
  }

  // Fetch membership first so we can unlink the space. getById reads by id alone
  // (companyId is what we're discovering here).
  const membership = await convex().query(api.org.memberships.getById, { id });

  if (!membership) return NextResponse.json({ error: 'Membership not found' }, { status: 404 });

  // Unlink space from company (best-effort)
  const space = await convex().query(api.workspace.spaces.getByOwnerId, {
    ownerId: membership.userId,
  });
  if (space) {
    await convex().mutation(api.workspace.spaces.unlinkCompany, { spaceId: space.id });
  }

  try {
    await convex().mutation(api.org.memberships.deleteById, { id });
  } catch (error) {
    console.error('[admin/memberships] delete failed', error);
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }

  await logAdminAction({ actor: admin.clerkUserId, action: 'delete_membership', target: id, details: {} });

  return NextResponse.json({ message: 'Membership removed' });
}
