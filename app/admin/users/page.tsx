import { convex, api } from '@/lib/convex-server';
import { UserListClient } from './user-list-client';
import { isPlatformAdmin } from '@/lib/permissions';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Users — Admin — Cola' };

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string }>;
}) {
  const isAdmin = await isPlatformAdmin();
  if (!isAdmin) redirect('/');

  const params = await searchParams;
  const query = params.q?.trim() || '';
  const filter = params.filter || 'all';

  // Server-side filters that listForAdmin pushes down; has-space/no-space + search
  // stay JS post-filters (they were client-side over the joined rows before too).
  const listArgs: { onboard?: boolean; platformRole?: 'banned'; limit: number } = { limit: 200 };
  if (filter === 'onboarded') listArgs.onboard = true;
  else if (filter === 'not-onboarded') listArgs.onboard = false;
  else if (filter === 'suspended') listArgs.platformRole = 'banned';

  const userRows = (await convex().query(api.org.users.listForAdmin, listArgs)) as Array<{
    id: string;
    name: string | null;
    email: string;
    onboard: boolean;
    createdAt: string;
    onboardingCurrentStep: number;
    platformRole: string;
  }>;

  // Resolve each user's owned Space (the old `Space(...)` embed is keyed on
  // Space.ownerId) and re-attach it as `r.Space` so the existing shaping holds.
  const ownerIds = userRows.map((u) => u.id);
  const spaces =
    ownerIds.length > 0
      ? ((await convex().query(api.workspace.spaces.listByOwnerIds, {
          ownerIds,
        })) as Array<{ ownerId: string; slug: string; name: string; stripeSubscriptionStatus: string }>)
      : [];
  const spaceByOwner = new Map(spaces.map((s) => [s.ownerId, s]));

  let results = userRows.map((u) => ({
    ...u,
    Space: spaceByOwner.get(u.id) ?? null,
  })) as any[];

  if (query) {
    const s = query.toLowerCase();
    results = results.filter((r: any) => {
      const sp = Array.isArray(r.Space) ? r.Space[0] : r.Space;
      return (
        r.name?.toLowerCase().includes(s) ||
        r.email?.toLowerCase().includes(s) ||
        sp?.slug?.toLowerCase().includes(s)
      );
    });
  }

  if (filter === 'has-space')
    results = results.filter((r: any) => {
      const sp = Array.isArray(r.Space) ? r.Space[0] : r.Space;
      return sp !== null && sp !== undefined;
    });
  if (filter === 'no-space')
    results = results.filter((r: any) => {
      const sp = Array.isArray(r.Space) ? r.Space[0] : r.Space;
      return !sp;
    });

  const users = results.map((row: any) => {
    const spaceData = Array.isArray(row.Space) ? row.Space[0] : row.Space;
    return {
      id: row.id as string,
      name: row.name as string | null,
      email: row.email as string,
      onboard: row.onboard as boolean,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : String(row.createdAt),
      onboardingCurrentStep: row.onboardingCurrentStep as number,
      platformRole: (row.platformRole ?? 'user') as string,
      space: spaceData?.slug
        ? {
            slug: spaceData.slug as string,
            name: spaceData.name as string,
            subscriptionStatus: (spaceData.stripeSubscriptionStatus as string | null) ?? null,
          }
        : null,
    };
  });

  const { total: totalCount } = await convex().query(api.org.users.counts, {});

  return (
    <div className="space-y-8 pb-12">
      <header className="space-y-1.5">
        <p className="text-sm text-muted-foreground">Management.</p>
        <h1
          className="text-3xl tracking-tight text-foreground"
          style={{ fontFamily: 'var(--font-title)' }}
        >
          Users
        </h1>
        <p className="text-sm text-muted-foreground">{totalCount} total accounts.</p>
      </header>
      <UserListClient users={users} query={query} filter={filter} resultCount={users.length} />
    </div>
  );
}
