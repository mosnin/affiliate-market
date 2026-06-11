'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Product, ProductListingStatus, ProductType } from '@/lib/types';
import { PRODUCT_LISTING_STATUS_OPTIONS, PRODUCT_TYPE_OPTIONS } from '@/lib/products';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { ProductPhotoEditor } from './product-photo-editor';

type FormValues = Partial<Product>;

interface Props {
  initial?: FormValues;
  onCancel: () => void;
  onSubmit: (values: FormValues) => void;
  submitting?: boolean;
  submitLabel?: string;
}

/**
 * Shared product create/edit form. Field set covers the software product
 * fields: name, tagline, category, pricing model, price, features, logo,
 * website URL, and publish status. Everything except name is optional so a
 * seller can list a product quickly and fill in the rest later.
 *
 * All inputs are the canonical <Input> / <Textarea> primitives so the form
 * inherits the product's paper-flat polish (no shadow, 2px focus ring,
 * quieter placeholder, 150ms transitions). The status/type pickers are
 * still native <select> for keyboard-first speed.
 *
 * Logo lives at the top — a product is what it looks like, not what its
 * catalog ID is. The featured photo is `photos[0]` (convention reused from
 * the list + detail pages).
 */
export function ProductForm({ initial = {}, onCancel, onSubmit, submitting, submitLabel = 'Save' }: Props) {
  const [v, setV] = useState<FormValues>({
    listingStatus: 'draft',
    photos: [],
    ...initial,
  });

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setV((prev) => ({ ...prev, [key]: value }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = (v.name ?? '').trim();
    if (!name) return;
    onSubmit({
      name,
      tagline: v.tagline?.toString().trim() || null,
      longDescription: v.longDescription?.toString().trim() || null,
      category: (v.category ?? null) as ProductType | null,
      pricingModel: (v.pricingModel ?? null) as FormValues['pricingModel'],
      priceCents: v.priceCents != null ? Number(v.priceCents) : null,
      currency: v.currency?.toString().trim() || null,
      billingPeriod: (v.billingPeriod ?? null) as FormValues['billingPeriod'],
      websiteUrl: v.websiteUrl?.toString().trim() || null,
      marketplaceSlug: v.marketplaceSlug?.toString().trim() || null,
      listingStatus: (v.listingStatus ?? 'draft') as ProductListingStatus,
      notes: v.notes?.toString() || null,
      photos: Array.isArray(v.photos) ? v.photos : [],
    });
  }

  // Native <select> styled to match <Input> — same height, border, radius,
  // padding, focus ring. Keeps the form a single visual row when type/status
  // sit next to pricing fields.
  const selectClasses = cn(
    'flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base transition-colors duration-150 outline-none md:text-sm',
    'dark:bg-input/30',
    'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* Logo / screenshots — the seller is showing a product, not filing a
          catalog form. The featured image sets what the list, the deal card,
          and the product detail show. */}
      <Field label="Logo / Screenshots">
        <ProductPhotoEditor
          value={v.photos ?? []}
          onChange={(next) => set('photos', next)}
        />
      </Field>

      {/* Name row */}
      <Field label="Product name" required>
        <Input
          type="text"
          required
          value={v.name ?? ''}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. Acme Analytics"
        />
      </Field>

      <Field label="Tagline">
        <Input
          type="text"
          value={v.tagline ?? ''}
          onChange={(e) => set('tagline', e.target.value)}
          placeholder="One-line value proposition"
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Website URL">
          <Input
            type="url"
            value={v.websiteUrl ?? ''}
            onChange={(e) => set('websiteUrl', e.target.value)}
            placeholder="https://…"
          />
        </Field>
        <Field label="Marketplace slug">
          <Input
            type="text"
            value={v.marketplaceSlug ?? ''}
            onChange={(e) => set('marketplaceSlug', e.target.value)}
            placeholder="acme-analytics"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Category">
          <select
            value={v.category ?? ''}
            onChange={(e) => set('category', (e.target.value || null) as ProductType | null)}
            className={selectClasses}
          >
            <option value="">—</option>
            {PRODUCT_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            value={v.listingStatus ?? 'draft'}
            onChange={(e) => set('listingStatus', e.target.value as ProductListingStatus)}
            className={selectClasses}
          >
            {PRODUCT_LISTING_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Field label="Pricing model">
          <select
            value={v.pricingModel ?? ''}
            onChange={(e) => set('pricingModel', (e.target.value || null) as FormValues['pricingModel'])}
            className={selectClasses}
          >
            <option value="">—</option>
            <option value="subscription">Subscription</option>
            <option value="one_time">One-time</option>
          </select>
        </Field>
        <Field label="Price (cents)">
          <Input
            type="number"
            min="0"
            step="1"
            value={v.priceCents ?? ''}
            onChange={(e) => set('priceCents', e.target.value === '' ? null : Number(e.target.value))}
            placeholder="4900"
          />
        </Field>
        <Field label="Billing period">
          <select
            value={v.billingPeriod ?? ''}
            onChange={(e) => set('billingPeriod', (e.target.value || null) as FormValues['billingPeriod'])}
            className={selectClasses}
          >
            <option value="">—</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </Field>
      </div>

      <Field label="Description">
        <Textarea
          value={v.longDescription ?? ''}
          onChange={(e) => set('longDescription', e.target.value)}
          rows={4}
          placeholder="Full product description for the marketplace listing."
        />
      </Field>

      <Field label="Notes">
        <Textarea
          value={v.notes ?? ''}
          onChange={(e) => set('notes', e.target.value)}
          rows={2}
          placeholder="Internal notes — not shown publicly."
        />
      </Field>

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !(v.name ?? '').trim()}>
          {submitting && <Loader2 className="animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}{required ? ' *' : ''}
      </span>
      {children}
    </label>
  );
}
