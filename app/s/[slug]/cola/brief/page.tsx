/**
 * /cola/brief — the dedicated daily brief page.
 *
 * The brief's serif morning sentence IS the page's identity, so we omit
 * the shell's static title to avoid two serif h1s stacking. The greeting
 * line ("Today.") still orients; everything below it is the brief.
 *
 * Renders the live brief — bypasses the lifecycle collapse so the seller
 * always sees the full brief when they navigate here intentionally.
 */

import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { getSpaceFromSlug } from '@/lib/space';
import { convex, api } from '@/lib/convex-server';
import { ColaPageShell } from '@/components/cola/cola-page-shell';
import { DailyBrief } from '@/components/cola/daily-brief';

export const dynamic = 'force-dynamic';

export default async function ColaBriefPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  const spaceOwner = await convex()
    .query(api.org.users.getByClerkId, { clerkId: userId })
    .catch(() => null);
  if (!spaceOwner || spaceOwner.id !== space.ownerId) notFound();

  return (
    <ColaPageShell greeting="Today.">
      <DailyBrief slug={slug} alwaysLive />
    </ColaPageShell>
  );
}
