import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { Package, Plus } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { getSpaceFromSlug, getSpaceForUser } from '@/lib/space';
import { formatCurrency } from '@/lib/formatting';
import { H1, TITLE_FONT, BODY_MUTED, PAGE_MAX, PRIMARY_PILL } from '@/lib/typography';
import type { Product } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ProductStatusBadge } from '@/components/products/product-status-badge';
import { StaggerList, StaggerItem } from '@/components/motion/stagger-list';

/** Category display labels — maps the 7 canonical enum values to readable names. */
const CATEGORY_LABELS: Record<string, string> = {
  saas: 'SaaS',
  devtools: 'Dev Tools',
  mobile_app: 'Mobile App',
  desktop_app: 'Desktop App',
  api_service: 'API Service',
  plugin: 'Plugin',
  other: 'Other',
};

/** Price display: if priceCents present, format it with billing period; else fall back to listPrice. */
function displayPrice(product: Product & Record<string, unknown>): string | null {
  const priceCents = product.priceCents as number | null | undefined;
  const currency = (product.currency as string | null) ?? 'usd';
  const billingPeriod = product.billingPeriod as string | null | undefined;
  const pricingModel = product.pricingModel as string | null | undefined;

  if (priceCents != null) {
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: priceCents % 100 === 0 ? 0 : 2,
    }).format(priceCents / 100);

    if (pricingModel === 'subscription' && billingPeriod) {
      return `${formatted}/${billingPeriod === 'monthly' ? 'mo' : 'yr'}`;
    }
    return formatted;
  }
  if (product.listPrice != null) {
    return formatCurrency(product.listPrice);
  }
  return null;
}

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

  let products: (Product & Record<string, unknown>)[] = [];
  let fetchError = false;
  try {
    const { data, error } = await supabase
      .from('Product')
      .select('*')
      .or(`spaceId.eq.${space.id},assignedSpaceId.eq.${space.id}`)
      .order('createdAt', { ascending: false });
    if (error) throw error;
    products = (data ?? []) as (Product & Record<string, unknown>)[];
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
      {/* Page header */}
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

      {/* Empty state */}
      {products.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-5 py-12 text-center">
          <Package size={28} className="mx-auto mb-3 text-muted-foreground/60" aria-hidden />
          <p className="text-sm text-foreground">Quiet — no products yet.</p>
          <p className={cn('text-xs mt-1', BODY_MUTED)}>
            Add your first software product to start selling through affiliates.
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
        <StaggerList stagger={0.03} className="divide-y divide-border/60">
          {products.map((product) => {
            const name = (product.name as string | null) ?? (product.address as string | null) ?? 'Untitled product';
            const tagline = product.tagline as string | null | undefined;
            const category = product.category as string | null | undefined;
            const published = product.published as boolean | null | undefined;
            const logoUrl = product.logoUrl as string | null | undefined;
            const price = displayPrice(product);

            return (
              <StaggerItem key={product.id}>
                <Link
                  href={`/s/${slug}/products/${product.id}`}
                  className="flex items-center gap-4 py-4 -mx-2 px-2 rounded-md hover:bg-muted/30 transition-colors"
                >
                  {/* Logo / icon */}
                  <div className="w-12 h-12 rounded-lg bg-muted overflow-hidden flex-shrink-0 flex items-center justify-center">
                    {logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={logoUrl}
                        alt={name}
                        className="w-full h-full object-contain"
                        loading="lazy"
                      />
                    ) : (
                      <Package size={18} className="text-muted-foreground/40" aria-hidden />
                    )}
                  </div>

                  {/* Facts */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="text-sm font-medium text-foreground truncate">{name}</p>
                    {tagline && (
                      <p className="text-xs text-muted-foreground truncate">{tagline}</p>
                    )}
                    <div className="flex items-center gap-2 pt-0.5">
                      <ProductStatusBadge status={product.listingStatus} />
                      {/* Published indicator */}
                      <span className={cn(
                        'text-[10px] font-medium px-1.5 py-0.5 rounded-full',
                        published
                          ? 'bg-positive-subtle text-positive dark:bg-positive-subtle dark:text-positive'
                          : 'bg-muted text-muted-foreground',
                      )}>
                        {published ? 'Published' : 'Draft'}
                      </span>
                      {category && CATEGORY_LABELS[category] && (
                        <span className="text-xs text-muted-foreground">
                          · {CATEGORY_LABELS[category]}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Price column */}
                  <div className="hidden sm:block flex-shrink-0 text-right">
                    {price != null ? (
                      <p className="text-sm font-semibold tabular-nums text-foreground">
                        {price}
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
