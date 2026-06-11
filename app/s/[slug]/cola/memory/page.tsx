import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';

/**
 * /cola/memory — legacy URL. Memory is configuration (how Cola works,
 * not what Cola did today) so it moved into Settings. Kept as a redirect
 * for bookmark safety.
 */
export default async function ColaMemoryRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  redirect(`/s/${slug}/settings?tab=memory`);
}
