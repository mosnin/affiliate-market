import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requireManager } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { sendCompanyInvitation } from '@/lib/email';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/lib/audit';
import { checkSeatCapacity } from '@/lib/company-seats';

/**
 * POST /api/manager/invite
 * Send a company invitation to an email address.
 * Idempotent: if a pending invite for the same email already exists, returns it without
 * creating a duplicate or sending another email.
 */
export async function POST(req: Request) {
  const { userId: clerkId } = await auth();
  let ctx;
  try {
    ctx = await requireManager();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let email: string, roleToAssign: string;
  try {
    ({ email, roleToAssign } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Validate inputs
  const trimmedEmail = (email ?? '').trim().toLowerCase().slice(0, 320);
  if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
  }
  if (!['manager_admin', 'seller_member'].includes(roleToAssign)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
  }

  // Only the owner can invite admins
  if (roleToAssign === 'manager_admin' && ctx.membership.role !== 'manager_owner') {
    return NextResponse.json({ error: 'Only the company owner can invite admins' }, { status: 403 });
  }

  // 100 invitations per manager per hour (shared budget with /api/manager/invite/bulk)
  const { allowed } = await checkRateLimit(`manager:invite:${ctx.dbUserId}`, 100, 3600);
  if (!allowed) return NextResponse.json({ error: 'Too many invitations sent. Try again in an hour.' }, { status: 429 });

  const { company, dbUserId } = ctx;

  // Cap: max 100 pending invitations per company
  let pendingCount = 0;
  try {
    pendingCount = await convex().query(api.org.invitations.countPending, {
      companyId: company.id,
      now: new Date().toISOString(),
    });
  } catch {
    pendingCount = 0;
  }
  if ((pendingCount ?? 0) >= 100) {
    return NextResponse.json(
      { error: 'Too many pending invitations. Cancel some before sending more.' },
      { status: 429 }
    );
  }

  // Check if this email already belongs to a member
  let existingUser: { id: string } | null = null;
  try {
    existingUser = await convex().query(api.org.users.getByEmail, { email: trimmedEmail });
  } catch {
    existingUser = null;
  }
  if (existingUser) {
    let existingMember: { id: string } | null = null;
    try {
      existingMember = await convex().query(api.org.memberships.getByCompanyUser, {
        companyId: company.id,
        userId: existingUser.id,
      });
    } catch {
      existingMember = null;
    }
    if (existingMember) {
      return NextResponse.json({ error: 'This person is already a member of your company' }, { status: 409 });
    }
  }

  // Idempotency: return existing pending invite for this email, but resend the email
  let existing: { id: string; roleToAssign: string; token: string } | null = null;
  try {
    existing = await convex().query(api.org.invitations.pendingForCompanyEmail, {
      companyId: company.id,
      email: trimmedEmail,
    });
  } catch {
    existing = null;
  }
  if (existing) {
    // Resend the invitation email (original may have failed or been missed)
    try {
      let resendInviter: { name: string | null } | null = null;
      try {
        resendInviter = await convex().query(api.org.users.getById, { id: dbUserId });
      } catch {
        resendInviter = null;
      }
      await sendCompanyInvitation({
        toEmail: trimmedEmail,
        companyName: company.name,
        inviterName: resendInviter?.name ?? 'Someone',
        roleToAssign: existing.roleToAssign as 'manager_admin' | 'seller_member',
        token: existing.token,
      });
    } catch (err) {
      console.error('[manager/invite] resend email failed for existing invite', err);
    }
    return NextResponse.json({ invitation: existing, duplicate: true }, { status: 200 });
  }

  // Seat-limit enforcement (BP3b): duplicates above returned early and don't
  // consume a new seat, so we only gate genuinely new invitations.
  const seatCheck = await checkSeatCapacity(company.id, 1);
  if (!seatCheck.ok) {
    const { plan, seatLimit, used } = seatCheck.usage;
    const needed = seatCheck.needed ?? 1;
    return NextResponse.json(
      {
        error: `Seat limit reached — your ${plan} plan allows ${seatLimit} seats and ${used} are in use. Upgrade or remove a member to invite ${needed} more.`,
        code: 'seat_limit',
        plan,
        used,
        limit: seatLimit,
        needed,
      },
      { status: 402 }
    );
  }

  // Resolve inviter name for email
  let inviterUser: { name: string | null; email: string | null } | null = null;
  try {
    inviterUser = await convex().query(api.org.users.getById, { id: dbUserId });
  } catch {
    inviterUser = null;
  }
  const inviterName = inviterUser?.name ?? inviterUser?.email ?? 'Someone';

  // Create invitation
  let invitation: { id: string; token: string } | null = null;
  try {
    const result = await convex().mutation(api.org.invitations.create, {
      companyId: company.id,
      email: trimmedEmail,
      roleToAssign: roleToAssign as 'manager_admin' | 'seller_member',
      invitedById: dbUserId,
    });
    invitation = result.invitation;
  } catch (invErr) {
    console.error('[manager/invite] insert failed', invErr);
    return NextResponse.json({ error: 'Failed to create invitation' }, { status: 500 });
  }
  if (!invitation) {
    console.error('[manager/invite] insert failed');
    return NextResponse.json({ error: 'Failed to create invitation' }, { status: 500 });
  }

  console.log('[manager/invite] Invitation created:', { id: invitation.id, role: roleToAssign });

  // Send email — must await before response returns so Vercel doesn't kill the function
  try {
    console.log('[manager/invite] Sending invitation email for invitation:', invitation.id);
    const emailResult = await sendCompanyInvitation({
      toEmail: trimmedEmail,
      companyName: company.name,
      inviterName,
      roleToAssign: roleToAssign as 'manager_admin' | 'seller_member',
      token: invitation.token,
    });
    console.log('[manager/invite] Email send completed for invitation:', invitation.id);
  } catch (err) {
    console.error('[manager/invite] email send FAILED:', err instanceof Error ? err.message : err);
  }

  void audit({ actorClerkId: clerkId ?? null, action: 'CREATE', resource: 'Invitation', resourceId: invitation.id, metadata: { email: trimmedEmail, roleToAssign, companyId: company.id } });

  return NextResponse.json({ invitation }, { status: 201 });
}
