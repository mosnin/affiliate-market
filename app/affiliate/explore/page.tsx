import Link from 'next/link';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  H1,
  BODY_MUTED,
  SECTION_LABEL,
  META,
  PAGE_RHYTHM,
  CARD,
  CHIP_NEUTRAL,
  PRIMARY_PILL,
} from '@/lib/typography';
import { getExploreProducts } from '@/lib/affiliates/explore';
import { MARKETPLACE_CATEGORIES, formatPrice, categoryLabel } from '@/lib/marketplace/products';
import { PLATFORM_FEE_PERCENT } from '@/lib/affiliates/fees';
import { GetLinkButton } from '@/components/affiliate/get-link-button';

export const metadata = {
  title: 'Explore software to promote — Cola',
  description:
    'Find software products to promote. Grab your referral link, share it with your audience, earn on every sale.',
};

function dollars(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string }>;
}) {
  const { category, q } = await searchParams;
  const products = await getExploreProducts({ category, q });

  return (
    <div className={cn('max-w-5xl mx-auto px-4 sm:px-6 py-10', PAGE_RHYTHM)}>
      {/* Header */}
      <header className="space-y-2 max-w-2xl">
        <p className={cn(SECTION_LABEL)}>Explore</p>
        <h1 className={cn(H1)}>
          Find software worth promoting.
        </h1>
        <p className={cn(BODY_MUTED)}>
          Grab your link, share it with your audience, earn on every sale it drives.
          Earnings shown are yours to keep — already net of Cola&apos;s {PLATFORM_FEE_PERCENT}% platform fee.
        </p>
      </header>

      {/* Search + category filters */}
      <section className="space-y-4">
        <form action="/affiliate/explore" method="GET" className="max-w-md">
          {category && <input type="hidden" name="category" value={category} />}
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 h-9 focus-within:ring-2 focus-within:ring-ring/30">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              type="search"
              name="q"
              defaultValue={q ?? ''}
              placeholder="Search products…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            />
          </div>
        </form>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Link
            href="/affiliate/explore"
            className={cn(
              'px-3 h-8 inline-flex items-center rounded-xl text-xs border transition-colors',
              !category
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card border-border text-muted-foreground hover:text-foreground',
            )}
          >
            All
          </Link>
          {MARKETPLACE_CATEGORIES.map((c) => (
            <Link
              key={c.value}
              href={`/affiliate/explore?category=${c.value}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
              className={cn(
                'px-3 h-8 inline-flex items-center rounded-xl text-xs border transition-colors',
                category === c.value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {c.label}
            </Link>
          ))}
        </div>
      </section>

      {/* Product grid */}
      {products.length === 0 ? (
        <div className="rounded-2xl border border-border bg-muted/20 px-5 py-14 text-center space-y-2">
          <p className={cn(BODY_MUTED)}>
            {q || category
              ? 'Nothing matches that yet. Try a different search.'
              : 'No software listed yet. Sellers are onboarding — check back soon.'}
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {products.map((p) => (
            <div
              key={p.id}
              className={cn(CARD, 'p-5 flex flex-col gap-4')}
            >
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-xl bg-muted overflow-hidden flex items-center justify-center shrink-0">
                  {p.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.logoUrl} alt={p.name} className="w-full h-full object-contain" loading="lazy" />
                  ) : (
                    <span className="text-sm font-semibold text-muted-foreground/60">
                      {p.name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/marketplace/p/${p.marketplaceSlug}`}
                      className="text-sm font-semibold text-foreground truncate hover:underline"
                    >
                      {p.name}
                    </Link>
                    {p.category && (
                      <span className={cn(CHIP_NEUTRAL, 'shrink-0')}>
                        {categoryLabel(p.category)}
                      </span>
                    )}
                  </div>
                  {p.tagline && (
                    <p className={cn(BODY_MUTED, 'mt-0.5 line-clamp-2')}>{p.tagline}</p>
                  )}
                  <p className={cn(META, 'mt-1 text-muted-foreground')}>
                    {formatPrice(p)} · by {p.sellerName}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 pt-3 border-t border-border">
                <div className="space-y-0.5 min-w-0">
                  <p className="text-sm font-semibold text-positive">
                    {p.commissionLabel}
                    {p.recurring && <span className={cn(META, 'ml-1.5 text-muted-foreground')}>recurring</span>}
                  </p>
                  {p.estimatedNetPerSaleCents != null && p.estimatedNetPerSaleCents > 0 && (
                    <p className={cn(BODY_MUTED)}>
                      ≈ {dollars(p.estimatedNetPerSaleCents)} to you per sale
                    </p>
                  )}
                </div>
                <GetLinkButton productId={p.id} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
