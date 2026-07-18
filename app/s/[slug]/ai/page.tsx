import { redirect } from 'next/navigation';

/**
 * /ai is an old route name. The unified Cola workspace lives at /cola —
 * pass the original ?q= search param through so command-palette deep links
 * keep working.
 */
export default async function AIRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { slug } = await params;
  const { q } = await searchParams;
  const target = q ? `/s/${slug}/cola?q=${encodeURIComponent(q)}` : `/s/${slug}/cola`;
  redirect(target);
}
