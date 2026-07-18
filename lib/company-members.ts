import { convex, api } from '@/lib/convex-server';

export interface CompanyMember {
  id: string;
  role: string;
  createdAt: string;
  userId: string;
  User: { id: string; name: string | null; email: string; onboard?: boolean } | null;
  Space: { id?: string; slug?: string; name?: string } | null;
}

/**
 * Fetch company members with User and Space data.
 * Uses separate queries to avoid PostgREST ambiguous FK issues
 * (CompanyMembership has two FKs to User: userId and invitedById).
 */
export async function getCompanyMembers(
  companyId: string,
  // opts is retained for call-site compatibility; the Convex reads return the
  // full User/Space rows, so the consumer destructures whichever columns it
  // needs (onboard / space name) without a per-projection query.
  _opts?: { includeOnboard?: boolean; includeSpaceName?: boolean }
): Promise<CompanyMember[]> {
  const memberships = await convex().query(api.org.memberships.listByCompany, { companyId });

  const raw = memberships ?? [];
  if (raw.length === 0) return [];

  const userIds = raw.map((m) => m.userId).filter(Boolean);

  const [users, spaces] = await Promise.all([
    convex().query(api.org.users.listByIds, { ids: userIds }),
    convex().query(api.workspace.spaces.listByOwnerIds, { ownerIds: userIds }),
  ]);

  const userMap = new Map((users ?? []).map((u: any) => [u.id, u]));
  const spaceMap = new Map((spaces ?? []).map((s: any) => [s.ownerId, s]));

  return raw.map((m) => ({
    id: m.id,
    role: m.role,
    createdAt: m.createdAt,
    userId: m.userId,
    User: userMap.get(m.userId) ?? null,
    Space: spaceMap.get(m.userId) ?? null,
  }));
}
