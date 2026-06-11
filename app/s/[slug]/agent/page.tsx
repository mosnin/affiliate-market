import { redirect } from 'next/navigation';

/**
 * /agent is an old route name. The unified Cola workspace lives at /cola —
 * preserve ?tab=settings (and any other tab values) for legacy deep links.
 */
export default async function AgentRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { slug } = await params;
  const { tab } = await searchParams;
  const target = tab ? `/s/${slug}/cola?tab=${encodeURIComponent(tab)}` : `/s/${slug}/cola`;
  redirect(target);
}
