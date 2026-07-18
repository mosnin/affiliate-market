/**
 * Shared listing-status pill for a Product.
 *
 * Listing status (draft / published / archived) is metadata, not signal.
 * The stylesheet's tone palette (amber/emerald/rose) is reserved for
 * "you owe action" cues — review states, follow-up timing, agent output.
 * A product being "Published" doesn't ask the seller to do anything; it's
 * just a fact. So this badge is intentionally muted: a single neutral pill
 * with a small icon, the same vocabulary on every surface it appears.
 *
 * Used by:
 *   - app/s/[slug]/products/page.tsx           (the product list)
 *   - components/products/product-detail-client.tsx  (detail page header)
 *   - components/deals/deal-product-picker.tsx  (linked-product row)
 */
import { CircleDot, PencilLine, Archive } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PRODUCT_LISTING_STATUS_OPTIONS } from '@/lib/products';
import type { ProductListingStatus } from '@/lib/types';

interface Props {
  status: ProductListingStatus;
  className?: string;
}

function iconFor(status: ProductListingStatus) {
  switch (status) {
    case 'draft':     return PencilLine;
    case 'published': return CircleDot;
    case 'archived':  return Archive;
    default:          return CircleDot;
  }
}

function labelFor(status: ProductListingStatus): string {
  return PRODUCT_LISTING_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

export function ProductStatusBadge({ status, className }: Props) {
  const Icon = iconFor(status);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
        'text-[11px] font-medium',
        'bg-muted text-muted-foreground',
        className,
      )}
    >
      <Icon size={11} aria-hidden />
      {labelFor(status)}
    </span>
  );
}
