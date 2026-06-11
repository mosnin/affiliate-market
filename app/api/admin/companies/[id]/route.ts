import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requirePlatformAdmin } from '@/lib/permissions';
import { supabase } from '@/lib/supabase';
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

  // Unlink all member spaces from the company first
  const { error: spaceError } = await supabase
    .from('Space')
    .update({ companyId: null })
    .eq('companyId', id);
  if (spaceError) {
    console.error('[admin/companies] space unlink failed', spaceError);
    return NextResponse.json({ error: 'Failed to unlink spaces' }, { status: 500 });
  }

  // Delete all memberships
  const { error: membershipError } = await supabase.from('CompanyMembership').delete().eq('companyId', id);
  if (membershipError) {
    console.error('[admin/companies] membership delete failed', membershipError);
    return NextResponse.json({ error: 'Failed to delete memberships' }, { status: 500 });
  }

  // Delete invitations
  const { error: invitationError } = await supabase.from('Invitation').delete().eq('companyId', id);
  if (invitationError) {
    console.error('[admin/companies] invitation delete failed', invitationError);
    return NextResponse.json({ error: 'Failed to delete invitations' }, { status: 500 });
  }

  // Delete the company
  const { error } = await supabase.from('Company').delete().eq('id', id);
  if (error) {
    console.error('[admin/companies] delete failed', error);
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

  const { data, error } = await supabase
    .from('Company')
    .update({ status })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  }

  await logAdminAction({ actor: admin.clerkUserId, action: 'update_company_status', target: id, details: { status } });

  return NextResponse.json({ company: data });
}
