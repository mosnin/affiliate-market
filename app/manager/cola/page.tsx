import { redirect } from 'next/navigation';

/**
 * /manager/cola — folded into the company home.
 *
 * The company chat is now the home surface at `/manager` (mirroring the
 * seller home). This route stays as a permanent redirect so existing links,
 * bookmarks, and the `?prompt=` deep-links keep working.
 */
export default async function ManagerColaRedirect({
  searchParams,
}: {
  searchParams: Promise<{ conversationId?: string; prompt?: string; prefill?: string }>;
}) {
  const { conversationId, prompt, prefill } = await searchParams;
  const qs = new URLSearchParams();
  if (conversationId) qs.set('conversationId', conversationId);
  if (prompt) qs.set('prompt', prompt);
  if (prefill) qs.set('prefill', prefill);
  const query = qs.toString();
  redirect(query ? `/manager?${query}` : '/manager');
}
