import type { ProductType, ProductListingStatus } from '@/lib/types';

export const PRODUCT_TYPE_OPTIONS: { value: ProductType; label: string }[] = [
  { value: 'saas',         label: 'SaaS' },
  { value: 'devtools',     label: 'Developer tools' },
  { value: 'mobile_app',  label: 'Mobile app' },
  { value: 'desktop_app', label: 'Desktop app' },
  { value: 'api_service', label: 'API service' },
  { value: 'plugin',      label: 'Plugin' },
  { value: 'other',       label: 'Other' },
];

export const PRODUCT_LISTING_STATUS_OPTIONS: { value: ProductListingStatus; label: string }[] = [
  { value: 'draft',     label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'archived',  label: 'Archived' },
];

const TYPE_SET = new Set(PRODUCT_TYPE_OPTIONS.map((o) => o.value));
const STATUS_SET = new Set(PRODUCT_LISTING_STATUS_OPTIONS.map((o) => o.value));

export function isValidProductType(v: unknown): v is ProductType {
  return typeof v === 'string' && TYPE_SET.has(v as ProductType);
}

export function isValidListingStatus(v: unknown): v is ProductListingStatus {
  return typeof v === 'string' && STATUS_SET.has(v as ProductListingStatus);
}

/**
 * A display label for a product. Returns name + category in a human-readable
 * form, e.g. "Acme Analytics (SaaS)". Kept as `formatProductAddress` for
 * import-name compatibility across the codebase.
 */
export function formatProductAddress(p: {
  name?: string | null;
  address?: string | null;
  category?: ProductType | string | null;
}): string {
  const name = p.name ?? p.address ?? 'Untitled product';
  const cat = p.category
    ? PRODUCT_TYPE_OPTIONS.find((o) => o.value === p.category)?.label ?? String(p.category)
    : null;
  return cat ? `${name} (${cat})` : name;
}

/**
 * Short chip line for a software product, e.g. "SaaS · $49/mo".
 * Replaces the real-estate `formatProductFacts` (beds/baths/sqft).
 * Export name kept as `formatProductFacts` for compatibility.
 */
export function formatProductFacts(p: {
  pricingModel?: string | null;
  priceCents?: number | null;
  billingPeriod?: string | null;
  category?: string | null;
}): string {
  const parts: string[] = [];
  if (p.category) {
    const label = PRODUCT_TYPE_OPTIONS.find((o) => o.value === p.category)?.label;
    if (label) parts.push(label);
  }
  if (p.priceCents != null && p.priceCents > 0) {
    const dollars = (p.priceCents / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    });
    const period = p.billingPeriod === 'yearly' ? '/yr' : p.billingPeriod === 'monthly' ? '/mo' : '';
    parts.push(`${dollars}${period}`);
  } else if (p.pricingModel) {
    parts.push(p.pricingModel === 'one_time' ? 'One-time' : 'Subscription');
  }
  return parts.join(' · ');
}
