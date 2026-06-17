import { redirect, notFound } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { getSpaceFromSlug } from '@/lib/space';
import { convex, api } from '@/lib/convex-server';
import { AgentBuilderForm } from '@/components/agents/agent-builder-form';
import type { CustomAgent } from '@/lib/swarm-types';

export const metadata = { title: 'Edit Agent — Cola' };

export default async function EditAgentPage({
  params,
}: {
  params: Promise<{ slug: string; agentId: string }>;
}) {
  const { slug, agentId } = await params;
  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  // Verify the authenticated user owns this space.
  const spaceOwner = await convex()
    .query(api.org.users.getByClerkId, { clerkId: userId })
    .catch(() => null);
  if (!spaceOwner || spaceOwner.id !== space.ownerId) notFound();

  // Fetch the agent and verify it belongs to this space.
  let agentData: CustomAgent | null = null;
  try {
    agentData = (await convex().query(api.agent.customAgents.getById, {
      id: agentId,
    })) as CustomAgent | null;
  } catch (error) {
    console.error('[agents/[agentId]] agent fetch error:', error);
    notFound();
  }

  const agent = agentData;
  if (!agent || agent.spaceId !== space.id) notFound();

  return (
    <div className="max-w-2xl mx-auto pb-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{agent.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {agent.description || 'No description'}
          </p>
        </div>
        <a
          href={`/s/${slug}/agents`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← All agents
        </a>
      </div>
      <AgentBuilderForm slug={slug} spaceId={space.id} initialAgent={agent} />
    </div>
  );
}
