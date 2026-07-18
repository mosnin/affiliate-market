import { getManagerContext } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { redirect } from 'next/navigation';
import { MembersClient } from './members-client';

export default async function ManagerMembersPage() {
  const ctx = await getManagerContext();
  if (!ctx) redirect('/');

  // listByCompany returns memberships createdAt-ASC (matches the old order).
  const rawMembers = (await convex().query(api.org.memberships.listByCompany, {
    companyId: ctx.company.id,
  })) as Array<{ id: string; role: string; createdAt: string; userId: string }>;
  const userIds = rawMembers.map((m) => m.userId).filter(Boolean);

  let users: any[] = [];
  let spaces: any[] = [];
  if (userIds.length > 0) {
    const [userRows, spaceRows] = await Promise.all([
      convex().query(api.org.users.listByIds, { ids: userIds }),
      convex().query(api.workspace.spaces.listByOwnerIds, { ownerIds: userIds }),
    ]);
    users = userRows ?? [];
    spaces = spaceRows ?? [];
  }

  const userMap = new Map(users.map((u: any) => [u.id, u]));
  const spaceMap = new Map(spaces.map((s: any) => [s.ownerId, s]));

  const members = rawMembers.map((m) => ({
    id: m.id,
    role: m.role,
    createdAt: m.createdAt,
    userId: m.userId,
    userName: userMap.get(m.userId)?.name ?? null,
    userEmail: userMap.get(m.userId)?.email ?? null,
    userOnboard: userMap.get(m.userId)?.onboard ?? false,
    spaceSlug: spaceMap.get(m.userId)?.slug ?? null,
  }));

  return (
    <MembersClient
      members={members}
      companyName={ctx.company.name}
      currentUserRole={ctx.membership.role}
    />
  );
}
