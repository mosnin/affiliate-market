import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { getSpaceFromSlug } from '@/lib/space';
import { convex, api } from '@/lib/convex-server';
import { ActivityFeed } from '@/components/cola/activity-feed';
import { ColaPageShell } from '@/components/cola/cola-page-shell';

export const metadata = { title: 'History — Cola' };

export default async function ColaHistoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  // Verify ownership before rendering
  const spaceOwner = await convex()
    .query(api.org.users.getByClerkId, { clerkId: userId })
    .catch(() => null);
  if (!spaceOwner || spaceOwner.id !== space.ownerId) notFound();

  return (
    <ColaPageShell
      greeting="Log."
      title="Here's what I did."
    >
      <ActivityFeed slug={slug} />
    </ColaPageShell>
  );
}
