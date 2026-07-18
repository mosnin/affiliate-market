import type { Metadata } from 'next';
import Link from 'next/link';
import { getPublishedProducts, MARKETPLACE_CATEGORIES } from '@/lib/marketplace/products';
import { ProductCard } from '@/components/marketplace/product-card';
import { TITLE_FONT } from '@/lib/typography';

export const metadata: Metadata = {
  title: 'Cola Marketplace — Find software. Buy in minutes.',
  description: 'Browse and buy software from independent sellers — instantly.',
};

// Revalidate once per minute so listings feel fresh without hammering the DB.
export const revalidate = 60;

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string }>;
}) {
  const { category, q } = await searchParams;

  const products = await getPublishedProducts({
    category: category || undefined,
    q: q || undefined,
  });

  const activeCategory = category || null;
  const activeQuery = q || '';

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 pb-16 sm:px-6">
      {/* Hero */}
      {!activeQuery && !activeCategory && (
        <header className="mb-10 space-y-3">
          <h1 className="text-3xl tracking-tight text-foreground sm:text-4xl" style={TITLE_FONT}>
            Find software. Buy in minutes.
          </h1>
          <p className="max-w-lg text-sm text-muted-foreground">
            Browse tools from verified sellers. Pay once or subscribe — license delivered instantly.
          </p>
        </header>
      )}

      {/* Search result header */}
      {(activeQuery || activeCategory) && (
        <header className="mb-8 space-y-1">
          <h1 className="text-2xl tracking-tight text-foreground" style={TITLE_FONT}>
            {activeQuery ? `Results for "${activeQuery}"` : null}
            {activeCategory && !activeQuery
              ? (MARKETPLACE_CATEGORIES.find((c) => c.value === activeCategory)?.label ?? activeCategory)
              : null}
          </h1>
          <p className="text-sm text-muted-foreground">
            {products.length} product{products.length === 1 ? '' : 's'}
          </p>
        </header>
      )}

      {/* Category pills */}
      <div className="mb-8 flex flex-wrap gap-2">
        <Link
          href="/marketplace"
          className={[
            'inline-flex h-8 items-center rounded-full px-3 text-xs font-medium transition-colors',
            !activeCategory
              ? 'bg-foreground text-background'
              : 'border border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
          ].join(' ')}
        >
          All
        </Link>
        {MARKETPLACE_CATEGORIES.map((cat) => (
          <Link
            key={cat.value}
            href={`/marketplace?category=${encodeURIComponent(cat.value)}`}
            className={[
              'inline-flex h-8 items-center rounded-full px-3 text-xs font-medium transition-colors',
              activeCategory === cat.value
                ? 'bg-foreground text-background'
                : 'border border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
            ].join(' ')}
          >
            {cat.label}
          </Link>
        ))}
      </div>

      {/* Product grid */}
      {products.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-5 py-16 text-center">
          <p className="text-sm text-foreground">No products found.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {activeQuery || activeCategory
              ? 'Try a different search or browse all categories.'
              : 'Check back soon — sellers are listing new software every day.'}
          </p>
          {(activeQuery || activeCategory) && (
            <Link
              href="/marketplace"
              className="mt-4 inline-flex h-8 items-center rounded-full border border-border px-4 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Browse all
            </Link>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </main>
  );
}
