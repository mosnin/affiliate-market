import { supabase } from '@/lib/supabase'; // Space lookup only (Space stays on Supabase — hybrid file)
import { convex, api } from '@/lib/convex-server';
import { getRatingForProducts } from '@/lib/marketplace/reviews';

export interface MarketplaceProduct {
  id: string;
  spaceId: string;
  sellerSlug: string;
  sellerName: string;
  name: string;
  tagline: string | null;
  longDescription: string | null;
  category: string | null;
  pricingModel: 'one_time' | 'subscription';
  priceCents: number | null;
  currency: string;
  billingPeriod: 'monthly' | 'yearly' | null;
  features: string[];
  logoUrl: string | null;
  websiteUrl: string | null;
  marketplaceSlug: string;
  featured: boolean;
  /** Platform-admin trust flag (set in admin moderation, never by the seller). */
  verified: boolean;
  /** Average published rating, one decimal, or null when there are no reviews. */
  avgRating: number | null;
  /** Count of published reviews. */
  reviewCount: number;
}

export const MARKETPLACE_CATEGORIES: { value: string; label: string }[] = [
  { value: 'saas', label: 'SaaS' },
  { value: 'devtools', label: 'Developer tools' },
  { value: 'mobile_app', label: 'Mobile apps' },
  { value: 'desktop_app', label: 'Desktop apps' },
  { value: 'api_service', label: 'API services' },
  { value: 'plugin', label: 'Plugins & extensions' },
  { value: 'other', label: 'Other' },
];

export function categoryLabel(value: string | null): string {
  return MARKETPLACE_CATEGORIES.find((c) => c.value === value)?.label ?? 'Software';
}

/** Human price line: "$49/mo", "$499", "Contact seller". */
export function formatPrice(p: {
  priceCents: number | null;
  pricingModel: string;
  billingPeriod: string | null;
}): string {
  if (p.priceCents == null) return 'Contact seller';
  const dollars = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: p.priceCents % 100 === 0 ? 0 : 2,
  }).format(p.priceCents / 100);
  if (p.pricingModel === 'subscription') {
    return `${dollars}/${p.billingPeriod === 'yearly' ? 'yr' : 'mo'}`;
  }
  return dollars;
}

interface ProductRow {
  id: string;
  spaceId: string;
  name: string | null;
  address: string | null;
  tagline: string | null;
  longDescription: string | null;
  category: string | null;
  pricingModel: string | null;
  priceCents: number | null;
  currency: string | null;
  billingPeriod: string | null;
  features: unknown;
  logoUrl: string | null;
  websiteUrl: string | null;
  marketplaceSlug: string | null;
  published: boolean | null;
  featured: boolean | null;
  verified: boolean | null;
}

function parseFeatures(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((f): f is string => typeof f === 'string');
  return [];
}

async function decorate(rows: ProductRow[]): Promise<MarketplaceProduct[]> {
  if (rows.length === 0) return [];
  const visible = rows.filter((r) => r.marketplaceSlug);
  const spaceIds = [...new Set(visible.map((r) => r.spaceId))];
  // Batch the seller lookup (Space — stays on Supabase) and the rating aggregate
  // (Review — Convex, via getRatingForProducts) together — one round trip each.
  const [{ data: spaces }, ratings] = await Promise.all([
    supabase.from('Space').select('id, slug, name').in('id', spaceIds),
    getRatingForProducts(visible.map((r) => r.id)),
  ]);
  const byId = new Map((spaces ?? []).map((s) => [s.id, s]));

  return visible.map((r) => {
    const rating = ratings.get(r.id);
    return {
      id: r.id,
      spaceId: r.spaceId,
      sellerSlug: byId.get(r.spaceId)?.slug ?? '',
      sellerName: byId.get(r.spaceId)?.name ?? 'Unknown seller',
      name: r.name ?? r.address ?? 'Untitled product',
      tagline: r.tagline,
      longDescription: r.longDescription,
      category: r.category,
      pricingModel: r.pricingModel === 'subscription' ? 'subscription' : 'one_time',
      priceCents: r.priceCents,
      currency: r.currency ?? 'usd',
      billingPeriod:
        r.billingPeriod === 'monthly' || r.billingPeriod === 'yearly' ? r.billingPeriod : null,
      features: parseFeatures(r.features),
      logoUrl: r.logoUrl,
      websiteUrl: r.websiteUrl,
      marketplaceSlug: r.marketplaceSlug as string,
      featured: Boolean(r.featured),
      verified: Boolean(r.verified),
      avgRating: rating?.avg ?? null,
      reviewCount: rating?.count ?? 0,
    };
  });
}

export async function getPublishedProducts(filter?: {
  category?: string;
  q?: string;
}): Promise<MarketplaceProduct[]> {
  // Published catalog (optional category filter), sorted featured-first then
  // updatedAt desc, capped 60 — all inside the Convex query.
  const rows = (await convex().query(api.marketplace.products.listPublished, {
    category: filter?.category ?? undefined,
  })) as ProductRow[];

  // Free-text search stays here: filter the returned rows on name/tagline (the
  // old `.or(name.ilike,tagline.ilike)`), wildcards stripped exactly as before.
  let out = rows;
  if (filter?.q) {
    const q = filter.q.replace(/[%_]/g, '').trim().toLowerCase();
    if (q) {
      out = rows.filter(
        (r) =>
          (r.name ?? '').toLowerCase().includes(q) ||
          (r.tagline ?? '').toLowerCase().includes(q),
      );
    }
  }
  return decorate(out);
}

export async function getProductBySlug(
  marketplaceSlug: string,
): Promise<MarketplaceProduct | null> {
  const data = (await convex().query(api.marketplace.products.getBySlugPublished, {
    marketplaceSlug,
  })) as ProductRow | null;
  if (!data) return null;
  const [product] = await decorate([data]);
  return product ?? null;
}

export async function getProductsForSeller(sellerSlug: string): Promise<MarketplaceProduct[]> {
  // Space (slug → id) stays on Supabase.
  const { data: space } = await supabase
    .from('Space')
    .select('id')
    .eq('slug', sellerSlug.toLowerCase())
    .maybeSingle();
  if (!space) return [];

  const rows = (await convex().query(api.marketplace.products.listPublishedForSpace, {
    spaceId: space.id,
  })) as ProductRow[];
  return decorate(rows);
}
