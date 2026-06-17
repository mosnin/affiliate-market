/**
 * API authentication helpers — replace repeated auth boilerplate in every route.
 *
 * Usage:
 *   const result = await requireSpaceOwner(slug);
 *   if (result instanceof NextResponse) return result;
 *   const { userId, space } = result;
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSpaceFromSlug, getSpaceForUser } from '@/lib/space';
import { convex, api } from '@/lib/convex-server';
import type { Space } from '@/lib/types';

/**
 * Returns { userId } or a 401/403 NextResponse.
 *
 * Company offboarding status gate: after Clerk auth succeeds we look up the
 * User row and reject with 403 if `status === 'offboarded'`. Offboarding is a
 * hard-stop initiated by a manager_owner/manager_admin when an agent leaves the
 * company; their book of business has been reassigned and they must lose API
 * access immediately, even though their Clerk session may still be valid. This
 * is the single choke-point for API auth, so enforcing it here blocks every
 * protected route uniformly. Resilience: if the User row is missing (user is
 * mid-onboarding) or the `status` column isn't present yet (the migration
 * adding it lands separately), we fall through as if active — this keeps the
 * check safe to deploy ahead of the migration.
 */
export async function requireAuth(): Promise<{ userId: string } | NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Offboarding hard-stop — see JSDoc above. Wrapped in try/catch so that a
  // missing `status` column (pre-migration) or transient DB issue does not
  // brick auth; we only block on a definitive 'offboarded' signal.
  try {
    const userRow = await convex().query(api.org.users.getByClerkId, { clerkId: userId });

    if (userRow && (userRow as { status?: string }).status === 'offboarded') {
      return NextResponse.json(
        { error: 'Your access has been revoked by your company.', code: 'offboarded' },
        { status: 403 },
      );
    }
  } catch {
    // Swallow: treat as active. The migration adding `status` may not have
    // run yet, and we never want this lookup to break authenticated traffic.
  }

  return { userId };
}

/**
 * Checks that a space has an active or trialing subscription.
 * Admins bypass the check. Returns null if OK, or a 403 NextResponse.
 */
export async function requireActiveSubscription(
  space: Space,
  userId?: string,
): Promise<NextResponse | null> {
  const status = space.stripeSubscriptionStatus ?? 'inactive';
  if (status === 'active' || status === 'trialing') return null;

  // Check if user is a platform admin (admins bypass paywall)
  if (userId) {
    const userRow = await convex().query(api.org.users.getByClerkId, { clerkId: userId });
    if (userRow?.platformRole === 'admin') return null;
  }

  return NextResponse.json(
    { error: 'Active subscription required' },
    { status: 403 },
  );
}

/**
 * Subscription states that pause premium AI under dunning (a lapsed PAID plan).
 * Deliberately EXCLUDES 'inactive' (free / never-subscribed) and
 * 'trialing'/'active', so free and trial users are never gated — only an
 * account whose paid subscription failed payment or was canceled.
 */
export function isSubscriptionDelinquent(status: string | null | undefined): boolean {
  return status === 'past_due' || status === 'canceled' || status === 'unpaid';
}

/**
 * Verifies the calling user owns the given workspace slug, OR is a
 * manager_owner/manager_admin of the company that manages this space.
 * Returns { userId, space } or a 4xx NextResponse.
 */
export async function requireSpaceOwner(
  slug: string,
): Promise<{ userId: string; space: Space } | NextResponse> {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  // Run both space lookups in parallel instead of sequentially
  const [space, userSpace] = await Promise.all([
    getSpaceFromSlug(slug),
    getSpaceForUser(userId),
  ]);
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  // Direct owner check
  if (userSpace && space.id === userSpace.id) {
    return { userId, space };
  }

  // Manager owner/admin check — allow managing company members' spaces
  const dbUser = await convex().query(api.org.users.getByClerkId, { clerkId: userId });

  if (dbUser) {
    // Check if the space belongs to a company the user is admin/owner of.
    // Fetch ALL manager-level memberships rather than .maybeSingle() — a user
    // who owns/admins more than one company would otherwise make
    // .maybeSingle() throw (PostgREST errors on >1 row), 500ing a legitimate
    // multi-company admin. Mirror the context helpers in lib/permissions.ts:
    // fetch all, then deterministically prefer manager_owner over manager_admin.
    const memberships = await convex().query(api.org.memberships.listByUser, {
      userId: dbUser.id,
      roles: ['manager_owner', 'manager_admin'],
    });

    // The caller may manager-own/admin MORE THAN ONE company. Grant access
    // when the space's owner belongs to ANY of them. The previous code collapsed
    // the memberships to a single one (manager_owner-first) and checked only that
    // company, so e.g. a manager_owner of A who is also manager_admin of B was
    // wrongly 403'd when opening a space owned by a B member.
    const managerCompanyIds = (memberships ?? []).map((m) => m.companyId);

    if (managerCompanyIds.length > 0) {
      // Does the space's owner share a company with the caller's managed set?
      // Resolve the owner's memberships and intersect with managerCompanyIds —
      // mirrors the old `.in('companyId', ids).eq('userId', space.ownerId)`.
      const ownerMemberships = await convex().query(api.org.memberships.listByUser, {
        userId: space.ownerId,
      });
      const managerSet = new Set(managerCompanyIds);
      const spaceOwnerMembership = (ownerMemberships ?? []).some((m) =>
        managerSet.has(m.companyId),
      );

      if (spaceOwnerMembership) {
        return { userId, space };
      }
    }
  }

  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

/**
 * Same as requireSpaceOwner but also enforces active subscription.
 */
export async function requirePaidSpaceOwner(
  slug: string,
): Promise<{ userId: string; space: Space } | NextResponse> {
  const result = await requireSpaceOwner(slug);
  if (result instanceof NextResponse) return result;
  const { userId, space } = result;

  const subCheck = await requireActiveSubscription(space, userId);
  if (subCheck) return subCheck;

  return { userId, space };
}

/**
 * Verifies the calling user owns the space that a contact belongs to.
 * Returns { userId, space, contactSpaceId } or a 4xx NextResponse.
 */
export async function requireContactAccess(
  contactId: string,
): Promise<{ userId: string; space: Space } | NextResponse> {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Convex throws on failure; the contact read returns the row only when it
  // exists AND lives in this space (spaceId arg enforces the scope), else null.
  const rows = await convex().query(api.contacts.contacts.getById, {
    id: contactId,
    spaceId: space.id,
  });

  if (!rows) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return { userId, space };
}
