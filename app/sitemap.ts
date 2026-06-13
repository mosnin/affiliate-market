import type { MetadataRoute } from 'next';
import {
  getPublishedProducts,
  MARKETPLACE_CATEGORIES,
} from '@/lib/marketplace/products';

/**
 * Marketing-site base URL. Prefer NEXT_PUBLIC_SITE_URL; fall back to the
 * production marketing host. Public root (usecola.com), not the app
 * subdomain.
 */
const BASE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://usecola.com'
).replace(/\/$/, '');

type ChangeFrequency = NonNullable<
  MetadataRoute.Sitemap[number]['changeFrequency']
>;

/**
 * Public marketing routes only — mirrors the page tree under
 * `app/(marketing)/**`. Authenticated (`/s`, `/manager`), setup, auth,
 * billing, and API routes are intentionally excluded (see robots.ts).
 */
const ROUTES: ReadonlyArray<{
  path: string;
  changeFrequency: ChangeFrequency;
  priority: number;
}> = [
  // Core marketing pages
  { path: '/', changeFrequency: 'weekly', priority: 1.0 },
  { path: '/sellers', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/companies', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/integrations', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/pricing', changeFrequency: 'weekly', priority: 0.9 },
  { path: '/company', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/demo', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/status', changeFrequency: 'daily', priority: 0.4 },
  // Marketplace surfaces
  { path: '/marketplace', changeFrequency: 'daily', priority: 0.8 },
  { path: '/affiliate', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/buyer', changeFrequency: 'monthly', priority: 0.7 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();

  const staticEntries: MetadataRoute.Sitemap = ROUTES.map(
    ({ path, changeFrequency, priority }) => ({
      url: `${BASE_URL}${path}`,
      lastModified,
      changeFrequency,
      priority,
    }),
  );

  // Category landing pages — static in-memory list, can't throw.
  const categoryEntries: MetadataRoute.Sitemap = MARKETPLACE_CATEGORIES.map(
    (c) => ({
      url: `${BASE_URL}/marketplace/c/${c.value}`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.6,
    }),
  );

  // Published product detail pages — DB-backed, so guard it. If the fetch
  // fails for any reason, fall back to the static + category routes rather
  // than letting the whole sitemap throw at build/runtime.
  let productEntries: MetadataRoute.Sitemap = [];
  try {
    const products = await getPublishedProducts();
    productEntries = products.map((product) => ({
      url: `${BASE_URL}/marketplace/p/${product.marketplaceSlug}`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.7,
    }));
  } catch {
    productEntries = [];
  }

  return [...staticEntries, ...categoryEntries, ...productEntries];
}
