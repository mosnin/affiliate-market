import { redirect } from 'next/navigation';

/**
 * Legacy seller public-profile URL /p/[slug] — now redirected to
 * /marketplace/p/[slug] which is the canonical product detail page.
 * 307 (temporary) preserved by Next.js `redirect()`; update to 308
 * once the old URL is retired from all emailed links.
 */
export default async function LegacySellerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/marketplace/p/${slug}`);
}
