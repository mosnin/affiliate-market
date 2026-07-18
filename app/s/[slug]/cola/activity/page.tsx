import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';

/**
 * /cola/activity — legacy URL. The page now lives at /cola/history
 * (seller's noun, not ours). Kept as a redirect for bookmark safety.
 */
export default async function ColaActivityRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  redirect(`/s/${slug}/cola/history`);
}
