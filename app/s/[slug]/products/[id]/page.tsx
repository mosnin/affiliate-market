import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { getSpaceFromSlug } from '@/lib/space';
import { supabase } from '@/lib/supabase';
import { formatProductAddress } from '@/lib/products';
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

  const { data: product } = await supabase
    .from('Product')
    .select('*')
    .eq('id', id)
    .eq('spaceId', space.id)
    .maybeSingle();
  if (!product) notFound();

  const [{ data: deals }, { data: demos }] = await Promise.all([
    supabase
      .from('Deal')
      .select('id, title, status, value, closeDate')
      .eq('productId', id)
      .eq('spaceId', space.id)
      .order('updatedAt', { ascending: false }),
    supabase
      .from('Demo')
      .select('id, guestName, startsAt, status')
      .eq('productId', id)
      .eq('spaceId', space.id)
      .order('startsAt', { ascending: false })
      .limit(20),
  ]);

  const addr = formatProductAddress(product as Product);

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      {/* Breadcrumb — the detail page is no longer an orphan child of /deals.
          Matches the contact-detail breadcrumb pattern: muted "back" link
          with chevron, in muted-foreground. */}
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
        <span className="truncate text-foreground">{addr}</span>
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
