import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';

/**
 * /integrations — legacy URL. Connected apps are configuration (how Cola
 * works, not what Cola did today) so it moved into Settings. Kept as a
 * redirect for bookmark safety. The seller-facing trust sentence
 * ("Cola never sends without your tap.") now lives in the Settings
 * Connections section.
 */
export default async function IntegrationsRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  redirect(`/s/${slug}/settings?tab=connections`);
}
