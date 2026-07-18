import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { getSpaceFromSlug } from '@/lib/space';
import { convex, api } from '@/lib/convex-server';
import { cn } from '@/lib/utils';
import { H1, TITLE_FONT, BODY_MUTED, PRIMARY_PILL } from '@/lib/typography';
import { AgentsGrid } from '@/components/agents/agents-grid';
import type { CustomAgent } from '@/lib/swarm-types';

export default async function AgentsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  // Verify the authenticated user owns this space.
  const spaceOwner = await convex()
    .query(api.org.users.getByClerkId, { clerkId: userId })
    .catch(() => null);
  if (!spaceOwner || spaceOwner.id !== space.ownerId) notFound();

  let data: CustomAgent[] = [];
  try {
    data = (await convex().query(api.agent.customAgents.listActiveBySpace, {
      spaceId: space.id,
    })) as CustomAgent[];
  } catch (error) {
    console.error('[agents/page] query error:', error);
  }

  const agents = data ?? [];

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-12">
      {/* Header */}
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <p className={cn(BODY_MUTED)}>Swarms.</p>
          <h1 className={cn(H1)} style={TITLE_FONT}>
            Custom Agents
          </h1>
          <p className={cn(BODY_MUTED)}>
            Build specialized AI agents for your swarm.
          </p>
        </div>

        <Link
          href={`/s/${slug}/agents/new`}
          className={cn(PRIMARY_PILL, 'mt-1 shrink-0')}
        >
          <Plus className="size-4" />
          New Agent
        </Link>
      </header>

      {/* Grid or empty state */}
      <AgentsGrid
        initialAgents={agents}
        slug={slug}
        spaceId={space.id}
      />
    </div>
  );
}
