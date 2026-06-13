import { supabase } from '@/lib/supabase';
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

const PRODUCT_COLUMNS =
  'id, spaceId, name, address, tagline, longDescription, category, pricingModel, priceCents, currency, billingPeriod, features, logoUrl, websiteUrl, marketplaceSlug, published, featured, verified';

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
  // Batch the seller lookup and the rating aggregate together — one round trip
  // each, no N+1 as the list grows.
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
  let query = supabase
    .from('Product')
    .select(PRODUCT_COLUMNS)
    .eq('published', true)
    .not('marketplaceSlug', 'is', null)
    .order('featured', { ascending: false })
    .order('updatedAt', { ascending: false })
    .limit(60);

  if (filter?.category) query = query.eq('category', filter.category);
  if (filter?.q) {
    const q = filter.q.replace(/[%_]/g, '').trim();
    if (q) query = query.or(`name.ilike.%${q}%,tagline.ilike.%${q}%`);
  }

  const { data } = await query;
  return decorate((data ?? []) as ProductRow[]);
}

export async function getProductBySlug(
  marketplaceSlug: string,
): Promise<MarketplaceProduct | null> {
  const { data } = await supabase
    .from('Product')
    .select(PRODUCT_COLUMNS)
    .eq('marketplaceSlug', marketplaceSlug)
    .eq('published', true)
    .maybeSingle();
  if (!data) return null;
  const [product] = await decorate([data as ProductRow]);
  return product ?? null;
}

export async function getProductsForSeller(sellerSlug: string): Promise<MarketplaceProduct[]> {
  const { data: space } = await supabase
    .from('Space')
    .select('id')
    .eq('slug', sellerSlug.toLowerCase())
    .maybeSingle();
  if (!space) return [];

  const { data } = await supabase
    .from('Product')
    .select(PRODUCT_COLUMNS)
    .eq('spaceId', space.id)
    .eq('published', true)
    .not('marketplaceSlug', 'is', null)
    .order('updatedAt', { ascending: false });
  return decorate((data ?? []) as ProductRow[]);
}
