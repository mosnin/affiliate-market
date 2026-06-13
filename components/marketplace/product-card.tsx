import Link from 'next/link';
import Image from 'next/image';
import type { MarketplaceProduct } from '@/lib/marketplace/products';
import { getInitials } from '@/lib/formatting';
import { formatPriceCents } from '@/components/marketplace/price-format';

export function ProductCard({ product }: { product: MarketplaceProduct }) {
  const initials = getInitials(product.name);

  return (
    <Link
      href={`/marketplace/p/${product.marketplaceSlug}`}
      className="group flex flex-col rounded-xl border border-border/70 bg-card p-4 transition-all duration-150 hover:border-border hover:shadow-sm"
    >
      {/* Logo block */}
      <div className="mb-3 flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted">
        {product.logoUrl ? (
          <Image
            src={product.logoUrl}
            alt={`${product.name} logo`}
            width={48}
            height={48}
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="text-sm font-semibold text-muted-foreground">{initials}</span>
        )}
      </div>

      {/* Name + category badge */}
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-foreground group-hover:underline group-hover:underline-offset-2">
          {product.name}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {product.featured && (
            <span className="rounded-full bg-brand-subtle px-2 py-0.5 text-[11px] font-medium text-primary">
              Featured
            </span>
          )}
          {product.category && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {product.category}
            </span>
          )}
        </div>
      </div>

      {/* Tagline */}
      {product.tagline && (
        <p className="mb-3 line-clamp-2 flex-1 text-xs text-muted-foreground">{product.tagline}</p>
      )}

      {/* Footer row: seller name + price */}
      <div className="mt-auto flex items-center justify-between gap-2 pt-2">
        <p className="truncate text-[11px] text-muted-foreground">{product.sellerName}</p>
        <p className="shrink-0 text-sm font-medium text-foreground">
          {formatPriceCents(product)}
        </p>
      </div>
    </Link>
  );
}
