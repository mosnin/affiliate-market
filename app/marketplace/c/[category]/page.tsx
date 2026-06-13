import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getPublishedProducts, MARKETPLACE_CATEGORIES, categoryLabel } from '@/lib/marketplace/products';
import { ProductCard } from '@/components/marketplace/product-card';

export const revalidate = 120;

function isValidCategory(c: string): boolean {
  return MARKETPLACE_CATEGORIES.some((m) => m.value === c);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const { category } = await params;
  if (!isValidCategory(category)) return { title: 'Category — Cola marketplace' };
  const label = categoryLabel(category);
  return {
    title: `${label} on the Cola marketplace`,
    description: `Browse ${label.toLowerCase()} you can buy in minutes and promote as an affiliate.`,
  };
}

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  if (!isValidCategory(category)) notFound();

  const products = await getPublishedProducts({ category });
  const label = categoryLabel(category);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 pb-16 sm:px-6 space-y-8">
      <Link
        href="/marketplace"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={13} aria-hidden /> Marketplace
      </Link>

      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">{label}</h1>
        <p className="text-sm text-muted-foreground">
          {products.length} {products.length === 1 ? 'product' : 'products'} in {label.toLowerCase()}.
        </p>
      </header>

      {/* Sibling categories */}
      <nav className="flex flex-wrap items-center gap-1.5">
        {MARKETPLACE_CATEGORIES.map((c) => (
          <Link
            key={c.value}
            href={`/marketplace/c/${c.value}`}
            className={
              'px-3 h-8 inline-flex items-center rounded-xl text-xs border transition-colors ' +
              (c.value === category
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card border-border text-muted-foreground hover:text-foreground')
            }
          >
            {c.label}
          </Link>
        ))}
      </nav>

      {products.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-5 py-14 text-center">
          <p className="text-sm text-muted-foreground">Nothing here yet — check back soon.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </main>
  );
}
