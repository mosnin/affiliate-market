import { redirect } from 'next/navigation';
import { isPlatformAdmin } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { SpaceListClient } from './space-list-client';

export const metadata = { title: 'Spaces — Admin — Cola' };

export default async function AdminSpacesPage() {
  const isAdmin = await isPlatformAdmin();
  if (!isAdmin) redirect('/');

  // listRecent returns full Space rows newest-first (cap 200) — the JSX projects
  // the columns it reads. Convex throws on failure, matching the old `throw error`.
  const spaces = (await convex().query(api.workspace.spaces.listRecent, {
    limit: 200,
  })) as Array<{
    id: string;
    slug: string;
    name: string;
    emoji: string;
    ownerId: string;
    companyId: string | null;
    createdAt: string;
    stripeSubscriptionStatus: string;
    stripePeriodEnd: string | null;
  }>;

  const ownerIds = [...new Set(spaces.map((s) => s.ownerId).filter(Boolean))];

  const owners =
    ownerIds.length > 0
      ? ((await convex().query(api.org.users.listByIds, { ids: ownerIds })) as Array<{
          id: string;
          name: string | null;
          email: string;
        }>)
      : [];

  const ownerMap: Record<string, { id: string; name: string | null; email: string }> = {};
  for (const o of owners) {
    ownerMap[o.id] = { id: o.id, name: o.name, email: o.email };
  }

  const totalCount = spaces?.length ?? 0;

  return (
    <div className="space-y-8 pb-12 max-w-5xl mx-auto">
      <header className="space-y-1.5">
        <p className="text-sm text-muted-foreground">Management.</p>
        <h1
          className="text-3xl tracking-tight text-foreground"
          style={{ fontFamily: 'var(--font-title)' }}
        >
          Spaces
        </h1>
        <p className="text-sm text-muted-foreground">{totalCount} total spaces.</p>
      </header>

      <SpaceListClient
        spaces={(spaces ?? []).map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          emoji: s.emoji,
          ownerId: s.ownerId,
          companyId: s.companyId,
          createdAt: s.createdAt,
          stripeSubscriptionStatus: s.stripeSubscriptionStatus,
          stripePeriodEnd: s.stripePeriodEnd,
        }))}
        ownerMap={ownerMap}
        totalCount={totalCount}
      />
    </div>
  );
}
