'use client';

/**
 * /s/[slug]/products/new — the standalone create flow for a listing.
 *
 * A product is a noun (the thing being sold). A deal is a verb (the
 * transaction on it). They earn different shapes; do not conflate. This
 * page is a single form, no wizard ceremony — every field except address
 * is optional, the form is one screen, the seller is done in 30s.
 *
 * Submit → POST /api/products → navigate to the new product's detail
 * page so the seller can add photos / refine status next.
 */

import { useRouter, useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { H1, TITLE_FONT, BODY_MUTED } from '@/lib/typography';
import { ProductForm } from '@/components/products/product-form';
import type { Product } from '@/lib/types';

export default function NewProductPage() {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(values: Partial<Product>) {
    setSubmitting(true);
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, ...values }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? "Couldn't create that product.");
        return;
      }
      const created = (await res.json()) as Product;
      router.push(`/s/${slug}/products/${created.id}`);
    } catch {
      toast.error("Couldn't create that product. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={cn('space-y-6 max-w-2xl mx-auto pb-12')}>
      <header className="space-y-1.5">
        <p className={cn(BODY_MUTED)}>Products.</p>
        <h1 className={cn(H1)} style={TITLE_FONT}>
          New listing
        </h1>
        <p className={cn(BODY_MUTED)}>What are you taking to market?</p>
      </header>

      <ProductForm
        onCancel={() => router.push(`/s/${slug}/products`)}
        onSubmit={handleSubmit}
        submitting={submitting}
        submitLabel="Create listing"
      />
    </div>
  );
}
