import { redirect, notFound } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { getSpaceFromSlug } from '@/lib/space';
import { convex, api } from '@/lib/convex-server';
import { AgentBuilderForm } from '@/components/agents/agent-builder-form';

export const metadata = { title: 'New Agent — Cola' };

export default async function NewAgentPage({
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

  return (
    <div className="max-w-2xl mx-auto pb-12">
      <div className="mb-8">
        <h1 className="text-xl font-semibold">New Agent</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Create a specialized AI agent for your swarms.
        </p>
      </div>
      <AgentBuilderForm slug={slug} spaceId={space.id} />
    </div>
  );
}
