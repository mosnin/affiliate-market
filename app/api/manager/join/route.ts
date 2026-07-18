import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/lib/audit';
import { checkSeatCapacity } from '@/lib/company-seats';
import { notifyManager } from '@/lib/manager-notify';
import { notificationForMemberJoined } from '@/lib/notification-voice';

/**
 * POST /api/manager/join
 * Join a company using its invite code.
 * Any authenticated, onboarded user can join. Assigns role: seller_member.
 *
 * Uses requireAuth (not raw Clerk auth()) so the offboarding gate fires —
 * an offboarded user clicking an old join-code link must NOT be able to
 * silently re-onboard themselves. Re-hire happens via an explicit
 * /api/invitations/[token] flow, which is the only path that intentionally
 * revives an offboarded User row.
 */
export async function POST(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId: clerkId } = authResult;

  // 10 join attempts per user per hour (prevents code enumeration)
  const { allowed } = await checkRateLimit(`manager:join:${clerkId}`, 10, 3600);
  if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });

  let code: string;
  try {
    ({ code } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const normalizedCode = (code ?? '').trim().toUpperCase();
  if (!normalizedCode) {
    return NextResponse.json({ error: 'Invite code required' }, { status: 400 });
  }

  // Resolve current user
  let user: { id: string; onboard: boolean } | null = null;
  try {
    user = await convex().query(api.org.users.getByClerkId, { clerkId });
  } catch {
    user = null;
  }
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  if (!user.onboard) return NextResponse.json({ error: 'Complete onboarding before joining a company' }, { status: 403 });

  // Find company by code
  let company: { id: string; name: string; status: string } | null = null;
  try {
    company = await convex().query(api.org.companies.getByJoinCode, { joinCode: normalizedCode });
  } catch {
    company = null;
  }

  if (!company) {
    return NextResponse.json({ error: 'Invalid invite code' }, { status: 404 });
  }

  if (company.status === 'suspended') {
    return NextResponse.json({ error: 'This company is currently suspended' }, { status: 403 });
  }

  // Idempotent: already a member?
  let existing: { id: string; role: string } | null = null;
  try {
    existing = await convex().query(api.org.memberships.getByCompanyUser, {
      companyId: company.id,
      userId: user.id,
    });
  } catch {
    existing = null;
  }

  if (existing) {
    return NextResponse.json({ companyName: company.name, alreadyMember: true }, { status: 200 });
  }

  // Deny-list check. If this user was previously removed from this
  // company, the anonymous code path is closed — the only way back
  // in is an explicit /api/invitations/[token] acceptance from a
  // manager_owner or manager_admin. A removed agent re-clicking the
  // join URL they kept in their email gets a clear 403; the manager
  // doesn't get a silent member_joined notification for someone they
  // already fired.
  let removed = false;
  try {
    removed = await convex().query(api.org.memberships.isRemoved, {
      companyId: company.id,
      userId: user.id,
    });
  } catch {
    removed = false;
  }
  if (removed) {
    return NextResponse.json(
      { error: 'Your access to this company was removed. Ask the manager to re-invite you by email.' },
      { status: 403 },
    );
  }

  // Seat cap — the invite paths enforce checkSeatCapacity, but self-join via the
  // (static, shareable) code did not, so anyone with the code could add
  // themselves past the plan's paid seat limit. Gate it the same way.
  const seat = await checkSeatCapacity(company.id, 1);
  if (!seat.ok) {
    return NextResponse.json(
      { error: 'This company has reached its seat limit. Ask the manager to add seats or remove a member.' },
      { status: 402 },
    );
  }

  // Create membership
  try {
    await convex().mutation(api.org.memberships.create, {
      companyId: company.id,
      userId: user.id,
      role: 'seller_member',
    });
  } catch (memberErr) {
    console.error('[manager/join] membership insert failed', memberErr);
    return NextResponse.json({ error: 'Failed to join company' }, { status: 500 });
  }

  // Adopt this company's intake form-config ONLY if the Space isn't already
  // linked. Membership (above) is the source of truth for access; Space.companyId
  // is just the intake-config owner — and a seller who belongs to company A
  // joining company B must NOT have B silently steal their workspace. Set it
  // only when currently NULL; never overwrite an existing link.
  let space: { id: string; companyId: string | null } | null = null;
  try {
    space = await convex().query(api.workspace.spaces.getByOwnerId, { ownerId: user.id });
  } catch {
    space = null;
  }
  if (space && !space.companyId) {
    try {
      await convex().mutation(api.workspace.spaces.setCompanyById, {
        id: space.id,
        companyId: company.id,
      });
    } catch {
      // best-effort: form-config adoption is non-critical, matching the old
      // fire-and-forget update.
    }
  }

  void audit({ actorClerkId: clerkId, action: 'CREATE', resource: 'CompanyMembership', metadata: { companyId: company.id, role: 'seller_member', method: 'join_code' } });

  // Resolve user email for notification
  let userData: { email: string | null } | null = null;
  try {
    userData = await convex().query(api.org.users.getById, { id: user.id });
  } catch {
    userData = null;
  }
  const joinCopy = notificationForMemberJoined(
    userData?.email ?? 'A new member',
    'seller_member',
    'join_code',
  );
  void notifyManager({
    companyId: company.id,
    type: 'member_joined',
    title: joinCopy.title,
    body: joinCopy.description,
    metadata: { userId: user.id, method: 'join_code' },
  });

  return NextResponse.json({ companyName: company.name }, { status: 201 });
}
