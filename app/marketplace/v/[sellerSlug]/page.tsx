import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getProductsForSeller } from '@/lib/marketplace/products';
import { ProductCard } from '@/components/marketplace/product-card';
import { TITLE_FONT } from '@/lib/typography';

export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ sellerSlug: string }>;
}): Promise<Metadata> {
  const { sellerSlug } = await params;
  const products = await getProductsForSeller(sellerSlug);
  const sellerName = products[0]?.sellerName ?? sellerSlug;
  return {
    title: `${sellerName} — Cola Marketplace`,
    description: `Browse software from ${sellerName} on Cola Marketplace.`,
  };
}

export default async function VendorPage({
  params,
}: {
  params: Promise<{ sellerSlug: string }>;
}) {
  const { sellerSlug } = await params;
  const products = await getProductsForSeller(sellerSlug);

  // If no products, there's no seller page to show
  if (products.length === 0) notFound();

  const sellerName = products[0].sellerName;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 pb-16 sm:px-6">
      <Link
        href="/marketplace"
        className="mb-8 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={13} aria-hidden="true" />
        Marketplace
      </Link>

      <header className="mb-8 space-y-1.5">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Seller
        </p>
        <h1 className="text-3xl tracking-tight text-foreground" style={TITLE_FONT}>
          {sellerName}
        </h1>
        <p className="text-sm text-muted-foreground">
          {products.length} product{products.length === 1 ? '' : 's'}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </main>
  );
}
