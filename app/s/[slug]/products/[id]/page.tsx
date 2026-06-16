import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { getSpaceFromSlug } from '@/lib/space';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import type { Product } from '@/lib/types';
import { ProductDetailClient } from '@/components/products/product-detail-client';

export const dynamic = 'force-dynamic';

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  const product = await convex().query(api.marketplace.products.getByIdInSpace, {
    id,
    spaceId: space.id,
  });
  if (!product) notFound();

  const [{ data: deals }, demos] = await Promise.all([
    supabase
      .from('Deal')
      .select('id, title, status, value, closeDate')
      .eq('productId', id)
      .eq('spaceId', space.id)
      .order('updatedAt', { ascending: false }),
    convex().query(api.demos.demos.listByProduct, {
      productId: id,
      spaceId: space.id,
      limit: 20,
    }),
  ]);

  const productName = product.name || 'Product';

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1 text-xs text-muted-foreground"
      >
        <Link
          href={`/s/${slug}/products`}
          className="hover:text-foreground transition-colors"
        >
          Products
        </Link>
        <ChevronRight size={11} aria-hidden className="text-muted-foreground/60" />
        <span className="truncate text-foreground">{productName}</span>
      </nav>

      <ProductDetailClient
        slug={slug}
        initial={product as Product}
        linkedDeals={(deals ?? []) as { id: string; title: string; status: string; value: number | null; closeDate: string | null }[]}
        linkedDemos={(demos ?? []) as { id: string; guestName: string; startsAt: string; status: string }[]}
      />
    </div>
  );
}
