import { convex, api } from '@/lib/convex-server';
import { normalizeSlug } from '@/lib/intake';
import type { Space } from '@/lib/types';

export async function getSpaceFromSlug(inputSlug: string): Promise<Space | null> {
  const slug = normalizeSlug(inputSlug);
  const data = await convex().query(api.workspace.spaces.getBySlug, { slug });
  // Convex returns ISO-string timestamps; the legacy Space type still annotates
  // createdAt as Date (a pre-migration fiction — Supabase returned strings too).
  // Cast through unknown; nothing reads these as Date objects.
  return (data as unknown as Space) ?? null;
}

export async function getSpaceByOwnerId(ownerId: string): Promise<Space | null> {
  // Space.ownerId is UNIQUE, so a user has at most one (producing) Space.
  // Note that space.companyId is the intake-config owner, NOT a membership
  // signal: membership lives in CompanyMembership. Don't read companyId as
  // "which company this user belongs to."
  const data = await convex().query(api.workspace.spaces.getByOwnerId, { ownerId });
  // Convex returns ISO-string timestamps; the legacy Space type still annotates
  // createdAt as Date (a pre-migration fiction — Supabase returned strings too).
  // Cast through unknown; nothing reads these as Date objects.
  return (data as unknown as Space) ?? null;
}

/**
 * The Space owner's notification address plus the bits needed to deep-link them
 * back into their workspace. One place for the Space.ownerId → User.email hop
 * that the new-sale email and the new-affiliate email both need. Null when the
 * space has no owner or the owner has no email on file — callers treat the
 * result as best-effort and never block fulfilment on it.
 */
export async function getSpaceOwnerEmail(
  spaceId: string,
): Promise<{ email: string; name: string; slug: string } | null> {
  const space = await convex().query(api.workspace.spaces.getById, { id: spaceId });
  if (!space?.ownerId) return null;
  const owner = await convex().query(api.org.users.getById, { id: space.ownerId });
  if (!owner?.email) return null;
  return { email: owner.email, name: (space.name as string) ?? '', slug: space.slug as string };
}

/**
 * True when the Clerk user owns the given Space. Space.ownerId is UNIQUE, so
 * ownership is the precise (spaceId, userId) binding. Used by the internal
 * integration routes to reject a mismatched pair — the AGENT_INTERNAL_SECRET
 * bearer authenticates Modal, not the space, so without this a caller could
 * charge another workspace's rate-limit budget or probe its connected toolkits.
 */
export async function userOwnsSpace(spaceId: string, clerkUserId: string): Promise<boolean> {
  const user = await convex().query(api.org.users.getByClerkId, { clerkId: clerkUserId });
  if (!user) return false;
  return await convex().query(api.workspace.spaces.ownsSpace, {
    spaceId,
    ownerId: user.id,
  });
}

export async function getSpaceForUser(clerkUserId: string): Promise<Space | null> {
  // Two queries but they're simple index lookups.
  //
  // The shape mirrors getSpaceFromSlug exactly — stripeSubscriptionStatus
  // is critical: requireActiveSubscription reads it directly from this row.
  // Previously this query omitted the column, so `space.stripeSubscriptionStatus`
  // came back undefined → coerced to 'inactive' → every paying seller was
  // blocked from any route that combined getSpaceForUser + requireActiveSubscription
  // (Studio generate/edit are the live callers). Active+trialing sellers saw
  // a 403 on a paid feature unless they happened to also be platform admins.
  // That's fiduciary harm — we were charging customers and locking them out.
  const user = await convex().query(api.org.users.getByClerkId, { clerkId: clerkUserId });
  if (!user) return null;

  const data = await convex().query(api.workspace.spaces.getByOwnerId, { ownerId: user.id });
  // Convex returns ISO-string timestamps; the legacy Space type still annotates
  // createdAt as Date (a pre-migration fiction — Supabase returned strings too).
  // Cast through unknown; nothing reads these as Date objects.
  return (data as unknown as Space) ?? null;
}
