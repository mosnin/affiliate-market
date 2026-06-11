import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { Building2, Plus } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { getSpaceFromSlug, getSpaceForUser } from '@/lib/space';
import { formatCurrency } from '@/lib/formatting';
import { formatProductAddress, formatProductFacts } from '@/lib/products';
import { H1, TITLE_FONT, BODY_MUTED, PAGE_MAX, PRIMARY_PILL } from '@/lib/typography';
import type { Product } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ProductStatusBadge } from '@/components/products/product-status-badge';
import { StaggerList, StaggerItem } from '@/components/motion/stagger-list';

export default async function ProductsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const { slug } = await params;
  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  const userSpace = await getSpaceForUser(userId);
  if (!userSpace || userSpace.id !== space.id) redirect('/');

  let products: Product[] = [];
  let fetchError = false;
  try {
    const { data, error } = await supabase
      .from('Product')
      .select('*')
      .or(`spaceId.eq.${space.id},assignedSpaceId.eq.${space.id}`)
      .order('createdAt', { ascending: false });
    if (error) throw error;
    products = (data ?? []) as Product[];
  } catch (err) {
    console.error('[products/page] DB query failed', { slug, error: err });
    fetchError = true;
  }

  if (fetchError) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center space-y-4 p-8">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className={cn(BODY_MUTED)}>
            We couldn&apos;t load your products. This is usually temporary.
          </p>
          <a
            href={`/s/${slug}/products`}
            className="inline-block px-4 py-2 text-sm font-medium rounded-md bg-foreground text-background hover:bg-foreground/90"
          >
            Try again
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-6 mx-auto pb-12', PAGE_MAX)}>
      {/* Page header — status-sentence pattern: muted greeting → serif h1
          → one-sentence status. Add-listing CTA sits inline; primary
          action lives where the seller's eye lands after the title. */}
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1.5 min-w-0">
          <p className={cn(BODY_MUTED)}>Products.</p>
          <h1 className={cn(H1)} style={TITLE_FONT}>
            All products
          </h1>
          <p className={cn(BODY_MUTED)}>
            {products.length === 0
              ? 'No products yet.'
              : `${products.length} ${products.length === 1 ? 'product' : 'products'}`}
          </p>
        </div>
        <Link
          href={`/s/${slug}/products/new`}
          className={cn(PRIMARY_PILL, 'inline-flex items-center gap-1.5 flex-shrink-0')}
        >
          <Plus size={14} aria-hidden />
          Add product
        </Link>
      </header>

      {/* Empty state — calm fact, not a directive. */}
      {products.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-5 py-12 text-center">
          <Building2 size={28} className="mx-auto mb-3 text-muted-foreground/60" aria-hidden />
          <p className="text-sm text-foreground">Quiet — no products yet.</p>
          <p className={cn('text-xs mt-1', BODY_MUTED)}>
            Add your first listing to start the register.
          </p>
          <Link
            href={`/s/${slug}/products/new`}
            className={cn(PRIMARY_PILL, 'inline-flex items-center gap-1.5 mt-4')}
          >
            <Plus size={14} aria-hidden />
            Add product
          </Link>
        </div>
      ) : (
        /* divide-y row list — mirrors the deal-product-picker pattern.
           Thumbnail (4:3 ~128px) + facts on the right. A product list is
           a working register, not a gallery; rows let the seller scan
           facts horizontally without the 4-column grid feeling like a
           spreadsheet export. */
        <StaggerList stagger={0.03} className="divide-y divide-border/60">
          {products.map((product) => {
            const addr = formatProductAddress(product);
            const facts = formatProductFacts(product);
            const cover = product.photos[0];

            return (
              <StaggerItem key={product.id}>
                <Link
                  href={`/s/${slug}/products/${product.id}`}
                  className="flex items-center gap-4 py-4 -mx-2 px-2 rounded-md hover:bg-muted/30 transition-colors"
                >
                  {/* Thumbnail */}
                  <div className="w-[128px] aspect-[4/3] rounded-md bg-muted overflow-hidden flex-shrink-0">
                    {cover ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={cover}
                        alt={addr}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
                        <Building2 size={20} aria-hidden />
                      </div>
                    )}
                  </div>

                  {/* Facts */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="text-sm font-medium text-foreground truncate">{addr}</p>
                    {facts && (
                      <p className="text-xs text-muted-foreground truncate">{facts}</p>
                    )}
                    <div className="flex items-center gap-2 pt-0.5">
                      <ProductStatusBadge status={product.listingStatus} />
                      {product.productType && (
                        <span className="text-xs text-muted-foreground">
                          · {product.productType.replace('_', ' ')}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Price column — tabular nums, right-aligned, hidden on
                      narrow screens so the row never wraps awkwardly. */}
                  <div className="hidden sm:block flex-shrink-0 text-right">
                    {product.listPrice != null ? (
                      <p className="text-sm font-semibold tabular-nums text-foreground">
                        {formatCurrency(product.listPrice)}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">No price</p>
                    )}
                  </div>
                </Link>
              </StaggerItem>
            );
          })}
        </StaggerList>
      )}
    </div>
  );
}
