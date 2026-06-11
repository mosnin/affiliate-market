import type { ProductType, ProductListingStatus } from '@/lib/types';

export const PRODUCT_TYPE_OPTIONS: { value: ProductType; label: string }[] = [
  { value: 'single_family', label: 'Single family' },
  { value: 'condo',         label: 'Condo' },
  { value: 'townhouse',     label: 'Townhouse' },
  { value: 'multi_family',  label: 'Multi-family' },
  { value: 'land',          label: 'Land' },
  { value: 'commercial',    label: 'Commercial' },
  { value: 'other',         label: 'Other' },
];

export const PRODUCT_LISTING_STATUS_OPTIONS: { value: ProductListingStatus; label: string }[] = [
  { value: 'active',     label: 'Active' },
  { value: 'pending',    label: 'Pending' },
  { value: 'sold',       label: 'Sold' },
  { value: 'off_market', label: 'Off market' },
  { value: 'owned',      label: 'Owned' },
];

const TYPE_SET = new Set(PRODUCT_TYPE_OPTIONS.map((o) => o.value));
const STATUS_SET = new Set(PRODUCT_LISTING_STATUS_OPTIONS.map((o) => o.value));

export function isValidProductType(v: unknown): v is ProductType {
  return typeof v === 'string' && TYPE_SET.has(v as ProductType);
}

export function isValidListingStatus(v: unknown): v is ProductListingStatus {
  return typeof v === 'string' && STATUS_SET.has(v as ProductListingStatus);
}

/** A single-line display string: "123 Main St #4B, Oakland". */
export function formatProductAddress(p: {
  address: string;
  unitNumber: string | null;
  city: string | null;
  stateRegion: string | null;
}): string {
  const unit = p.unitNumber ? ` #${p.unitNumber}` : '';
  const cityState = [p.city, p.stateRegion].filter(Boolean).join(', ');
  return cityState ? `${p.address}${unit}, ${cityState}` : `${p.address}${unit}`;
}

/** Short chips like "3bd · 2ba · 1,450 sqft". */
export function formatProductFacts(p: {
  beds: number | null;
  baths: number | null;
  squareFeet: number | null;
}): string {
  const parts: string[] = [];
  if (p.beds != null) parts.push(`${p.beds}bd`);
  if (p.baths != null) parts.push(`${p.baths}ba`);
  if (p.squareFeet != null) parts.push(`${p.squareFeet.toLocaleString()} sqft`);
  return parts.join(' · ');
}
