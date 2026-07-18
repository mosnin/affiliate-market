'use client';

import { useParams } from 'next/navigation';
import { ProductCard } from './product-card';

interface ProductSummary {
  id: string;
  address: string;
  price?: number | null;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  listingStatus?: string;
}

interface ProductsResultData {
  products: ProductSummary[];
}

export function ProductsResult({ data }: { data: ProductsResultData }) {
  const params = useParams();
  const slug = params?.slug as string | undefined;
  if (!data.products?.length) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {data.products.map((p, i) => (
        <ProductCard key={p.id} product={p} slug={slug ?? ''} animDelay={i * 0.05} />
      ))}
    </div>
  );
}
