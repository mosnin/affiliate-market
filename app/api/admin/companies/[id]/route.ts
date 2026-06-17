import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requirePlatformAdmin } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit } from '@/lib/rate-limit';
import { logAdminAction } from '@/lib/admin';

type Params = { params: Promise<{ id: string }> };

/**
 * DELETE /api/admin/companies/[id]
 * Removes all memberships, unlinks spaces, then deletes the company.
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

  // Full company teardown in one atomic mutation: unlink member spaces
  // (companyId cleared — spaces survive), delete memberships + invitations,
  // purge the company's credit rows, then delete the company.
  try {
    const deleted = await convex().mutation(api.org.companies.deleteWithCascade, { id });
    if (!deleted) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }
  } catch (err) {
    console.error('[admin/companies] delete failed', err);
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }

  await logAdminAction({ actor: admin.clerkUserId, action: 'delete_company', target: id, details: {} });

  return NextResponse.json({ message: 'Company deleted' });
}

/** PATCH /api/admin/companies/[id] — suspend or reactivate a company */
export async function PATCH(req: Request, { params }: Params) {
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

  let status: string;
  try {
    ({ status } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!['active', 'suspended'].includes(status)) {
    return NextResponse.json({ error: 'status must be active or suspended' }, { status: 400 });
  }

  let company;
  try {
    company = await convex().mutation(api.org.companies.updateById, {
      id,
      patch: { status: status as 'active' | 'suspended' },
    });
  } catch {
    company = null;
  }
  if (!company) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  }

  await logAdminAction({ actor: admin.clerkUserId, action: 'update_company_status', target: id, details: { status } });

  return NextResponse.json({ company });
}
