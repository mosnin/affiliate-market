import { NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { notifyManager } from '@/lib/manager-notify';
import { notificationForMemberJoined } from '@/lib/notification-voice';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { checkSeatCapacity } from '@/lib/company-seats';

/**
 * GET /api/invitations/[token]
 * Public read: returns invitation details for the accept page.
 * Does NOT expose sensitive fields like invitedById or full user data.
 *
 * POST /api/invitations/[token]
 * Accept an invitation. Requires the current user to be authenticated.
 */

type Params = { params: Promise<{ token: string }> };

export async function GET(req: Request, { params }: Params) {
  const { token } = await params;
  if (!token || token.length > 200) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  // Rate limit token lookups to prevent enumeration
  const ip = getClientIp(req);
  const { allowed } = await checkRateLimit(`invite:token:${ip}`, 10, 60);
  if (!allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const { data: inv } = await supabase
    .from('Invitation')
    .select('id, status, email, roleToAssign, expiresAt, companyId, Company(name, logoUrl)')
    .eq('token', token)
    .maybeSingle();

  if (!inv) return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });

  const company = inv.Company as unknown as { name: string; logoUrl: string | null } | null;
  return NextResponse.json({
    id: inv.id,
    status: inv.status,
    email: inv.email,
    roleToAssign: inv.roleToAssign,
    expiresAt: inv.expiresAt,
    companyName: company?.name ?? '',
    logoUrl: company?.logoUrl ?? null,
  });
}

export async function POST(_req: Request, { params }: Params) {
  const { token } = await params;

  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!token || token.length > 200) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  // Fetch the invitation with its company
  const { data: inv } = await supabase
    .from('Invitation')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (!inv) return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
  if (inv.status !== 'pending') {
    return NextResponse.json({ error: `Invitation is ${inv.status}` }, { status: 409 });
  }
  if (new Date(inv.expiresAt) < new Date()) {
    // Mark expired
    await supabase.from('Invitation').update({ status: 'expired' }).eq('id', inv.id);
    return NextResponse.json({ error: 'Invitation has expired' }, { status: 410 });
  }

  // Check company is still active
  const { data: company } = await supabase
    .from('Company')
    .select('id, status')
    .eq('id', inv.companyId)
    .maybeSingle();
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  if (company.status === 'suspended') {
    return NextResponse.json({ error: 'This company has been suspended' }, { status: 403 });
  }

  // Resolve current user — auto-create the DB record if they just signed up
  // (e.g. a new user clicking an invite link who hasn't gone through /setup yet).
  let user: { id: string; email: string } | null = null;
  const { data: existingUser } = await supabase
    .from('User')
    .select('id, email')
    .eq('clerkId', clerkId)
    .maybeSingle();
  if (existingUser) {
    user = existingUser;
  } else {
    // Auto-provision: fetch profile from Clerk and create the DB record
    const clerkUser = await currentUser();
    if (!clerkUser) return NextResponse.json({ error: 'User not found — complete sign-up first' }, { status: 404 });
    const email = clerkUser.emailAddresses?.[0]?.emailAddress ?? '';
    const name = clerkUser.fullName ?? clerkUser.firstName ?? null;
    const { data: newUser, error: insertErr } = await supabase
      .from('User')
      .upsert(
        {
          id: crypto.randomUUID(),
          clerkId,
          email,
          name,
          onboardingStartedAt: new Date().toISOString(),
          onboard: false,
        },
        { onConflict: 'clerkId' }
      )
      .select('id, email')
      .single();
    if (insertErr || !newUser) {
      console.error('[invitations/accept] auto-provision user failed', insertErr);
      return NextResponse.json({ error: 'Failed to create user account' }, { status: 500 });
    }
    user = newUser;
  }
  if (!user) return NextResponse.json({ error: 'User not found — complete sign-up first' }, { status: 404 });

  // Verify this invitation was meant for the signed-in user's email
  if (user.email.toLowerCase() !== inv.email.toLowerCase()) {
    return NextResponse.json(
      { error: 'This invitation was sent to a different email address. Please sign in with the correct email to accept.' },
      { status: 403 }
    );
  }

  // Idempotent: already a member?
  const { data: existingMembership } = await supabase
    .from('CompanyMembership')
    .select('id')
    .eq('companyId', inv.companyId)
    .eq('userId', user.id)
    .maybeSingle();
  if (existingMembership) {
    // Mark accepted and return OK
    await supabase.from('Invitation').update({ status: 'accepted' }).eq('id', inv.id);
    return NextResponse.json({ message: 'Already a member', roleToAssign: inv.roleToAssign }, { status: 200 });
  }

  // Enforce the company's seat cap at accept time, not just at invite time.
  // The invite-time check (manager/invite) can be outrun: invites issued under
  // the cap, concurrent accepts, or memberships added by other paths can push a
  // company over its paid seats. This pending invite is already counted in
  // `used` (members + pending), so we ask for 0 additional and simply refuse if
  // the company is already at/over its limit. Fails closed on infra error.
  const seat = await checkSeatCapacity(inv.companyId, 0);
  if (!seat.ok) {
    return NextResponse.json(
      { error: 'This company has reached its seat limit. Ask the manager to upgrade the plan or free up a seat.' },
      { status: 402 },
    );
  }

  // Create membership
  const { error: memberErr } = await supabase
    .from('CompanyMembership')
    .insert({
      companyId: inv.companyId,
      userId: user.id,
      role: inv.roleToAssign,
      invitedById: inv.invitedById,
    });
  if (memberErr) {
    console.error('[invitations/accept] membership insert failed', memberErr);
    return NextResponse.json({ error: 'Failed to join company' }, { status: 500 });
  }

  // If this user had been offboarded previously (BP1 set User.status =
  // 'offboarded' and requireAuth gates on that), joining a new company
  // revives them. Without this flip, the agent would create the membership
  // row, then bounce at every API call because the auth gate still 403s.
  // Best-effort — a failure here is not fatal (the membership exists, a
  // future admin action can re-activate).
  await supabase
    .from('User')
    .update({ status: 'active' })
    .eq('id', user.id)
    .eq('status', 'offboarded');

  // Adopt this company's intake form-config ONLY if the Space isn't already
  // linked. Never overwrite an existing link: a seller already in company A
  // accepting an invite to company B keeps A as their workspace's form-config
  // owner. Access comes from the membership row above; Space.companyId is only
  // the intake-config owner.
  const { data: space } = await supabase
    .from('Space')
    .select('id, companyId')
    .eq('ownerId', user.id)
    .maybeSingle();
  if (space && !space.companyId) {
    await supabase
      .from('Space')
      .update({ companyId: inv.companyId })
      .eq('id', space.id);
  }

  // For manager_admin invitees without a Space, set them as manager_only
  // so they skip subscription/workspace requirements.
  if (inv.roleToAssign === 'manager_admin' && !space) {
    await supabase
      .from('User')
      .update({ accountType: 'manager_only', onboard: true })
      .eq('id', user.id);
  }

  // Mark invitation accepted
  await supabase.from('Invitation').update({ status: 'accepted' }).eq('id', inv.id);

  void audit({ actorClerkId: clerkId, action: 'CREATE', resource: 'CompanyMembership', metadata: { companyId: inv.companyId, role: inv.roleToAssign, method: 'email_invitation', invitationId: inv.id } });

  const inviteCopy = notificationForMemberJoined(
    user.email,
    inv.roleToAssign === 'manager_admin' ? 'manager_admin' : 'seller_member',
    'email_invitation',
  );
  void notifyManager({
    companyId: inv.companyId,
    type: 'member_joined',
    title: inviteCopy.title,
    body: inviteCopy.description,
    metadata: { userId: user.id, method: 'email_invitation' },
  });

  return NextResponse.json({ message: 'Joined company successfully', roleToAssign: inv.roleToAssign }, { status: 200 });
}
