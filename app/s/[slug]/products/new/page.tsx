'use client';

/**
 * /s/[slug]/products/new — create a software product.
 *
 * Fields align with the Product contract:
 *   name (required, maps to existing `address` field for API compat),
 *   tagline, category, pricingModel, priceCents (input as dollars → cents),
 *   billingPeriod, features (textarea, one per line → string[]),
 *   logoUrl, websiteUrl, notes, published + marketplaceSlug.
 *
 * POST → /api/products. The API's sanitiseBody only accepts fields it
 * recognises; new fields (tagline, category, pricingModel, priceCents,
 * billingPeriod, features, logoUrl, websiteUrl, published, marketplaceSlug)
 * are passed through and stored as-is by Postgres (they exist as columns
 * on the Product table). See API FIELD MISMATCH note below.
 */

import { useRouter, useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { H1, TITLE_FONT, BODY_MUTED, PRIMARY_PILL, GHOST_PILL } from '@/lib/typography';
import { Package } from 'lucide-react';

const CATEGORIES = [
  { value: 'saas', label: 'SaaS' },
  { value: 'devtools', label: 'Dev Tools' },
  { value: 'mobile_app', label: 'Mobile App' },
  { value: 'desktop_app', label: 'Desktop App' },
  { value: 'api_service', label: 'API Service' },
  { value: 'plugin', label: 'Plugin' },
  { value: 'other', label: 'Other' },
] as const;

function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function fieldClass(extra = '') {
  return cn(
    'w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm outline-none',
    'placeholder:text-muted-foreground focus:ring-2 focus:ring-ring focus:bg-background transition-colors',
    extra,
  );
}

function labelClass() {
  return 'block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5';
}

export default function NewProductPage() {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [category, setCategory] = useState('');
  const [pricingModel, setPricingModel] = useState<'one_time' | 'subscription'>('subscription');
  const [priceDollars, setPriceDollars] = useState('');
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly'>('monthly');
  const [features, setFeatures] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [published, setPublished] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Product name is required.');
      return;
    }

    setSubmitting(true);
    try {
      const priceCents = priceDollars !== ''
        ? Math.round(parseFloat(priceDollars) * 100)
        : null;

      const featuresArr = features
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => f.length > 0);

      const marketplaceSlug = published ? slugify(name) : null;

      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          // Map name → address for API compat (the API requires `address`)
          address: name.trim(),
          notes: notes.trim() || null,
          // New software product fields
          tagline: tagline.trim() || null,
          category: category || null,
          pricingModel,
          priceCents,
          currency: 'usd',
          billingPeriod: pricingModel === 'subscription' ? billingPeriod : null,
          features: featuresArr.length > 0 ? featuresArr : null,
          logoUrl: logoUrl.trim() || null,
          websiteUrl: websiteUrl.trim() || null,
          published,
          marketplaceSlug,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? "Couldn't create that product.");
        return;
      }

      const created = (await res.json()) as { id: string };
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
          New product
        </h1>
        <p className={cn(BODY_MUTED)}>What are you taking to market?</p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Name */}
        <div>
          <label htmlFor="name" className={labelClass()}>
            Product name <span className="text-destructive">*</span>
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Analytics"
            className={fieldClass()}
            required
          />
        </div>

        {/* Tagline */}
        <div>
          <label htmlFor="tagline" className={labelClass()}>Tagline</label>
          <input
            id="tagline"
            type="text"
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            placeholder="One sentence that sells it"
            className={fieldClass()}
            maxLength={160}
          />
        </div>

        {/* Category */}
        <div>
          <label htmlFor="category" className={labelClass()}>Category</label>
          <select
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={fieldClass()}
          >
            <option value="">— Select a category —</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>

        {/* Pricing model */}
        <div>
          <label className={labelClass()}>Pricing model</label>
          <div className="flex gap-3">
            {(['subscription', 'one_time'] as const).map((m) => (
              <label
                key={m}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 rounded-lg border cursor-pointer text-sm transition-colors',
                  pricingModel === m
                    ? 'border-foreground bg-foreground/[0.04] text-foreground font-medium'
                    : 'border-border text-muted-foreground hover:border-foreground/40',
                )}
              >
                <input
                  type="radio"
                  name="pricingModel"
                  value={m}
                  checked={pricingModel === m}
                  onChange={() => setPricingModel(m)}
                  className="sr-only"
                />
                {m === 'subscription' ? 'Subscription (MRR)' : 'One-time'}
              </label>
            ))}
          </div>
        </div>

        {/* Price + billing period */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="priceDollars" className={labelClass()}>
              {pricingModel === 'subscription' ? 'Subscription price' : 'Price'} (USD)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                id="priceDollars"
                type="number"
                min="0"
                step="0.01"
                value={priceDollars}
                onChange={(e) => setPriceDollars(e.target.value)}
                placeholder="0.00"
                className={fieldClass('pl-7')}
              />
            </div>
          </div>

          {pricingModel === 'subscription' && (
            <div>
              <label htmlFor="billingPeriod" className={labelClass()}>Billing period</label>
              <select
                id="billingPeriod"
                value={billingPeriod}
                onChange={(e) => setBillingPeriod(e.target.value as 'monthly' | 'yearly')}
                className={fieldClass()}
              >
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </div>
          )}
        </div>

        {/* Features */}
        <div>
          <label htmlFor="features" className={labelClass()}>Features</label>
          <p className="text-xs text-muted-foreground mb-2">One feature per line. These appear on your marketplace listing.</p>
          <textarea
            id="features"
            value={features}
            onChange={(e) => setFeatures(e.target.value)}
            placeholder={"Unlimited seats\nAPI access\nPriority support"}
            rows={5}
            className={fieldClass('resize-y min-h-[100px]')}
          />
        </div>

        {/* Logo URL */}
        <div>
          <label htmlFor="logoUrl" className={labelClass()}>Logo URL</label>
          <input
            id="logoUrl"
            type="url"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://your-cdn.com/logo.png"
            className={fieldClass()}
          />
        </div>

        {/* Website URL */}
        <div>
          <label htmlFor="websiteUrl" className={labelClass()}>Website URL</label>
          <input
            id="websiteUrl"
            type="url"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
            placeholder="https://yourproduct.com"
            className={fieldClass()}
          />
        </div>

        {/* Notes */}
        <div>
          <label htmlFor="notes" className={labelClass()}>Internal notes</label>
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything for your team — not shown publicly"
            rows={3}
            className={fieldClass('resize-y')}
          />
        </div>

        {/* Publish to marketplace */}
        <div className="rounded-xl border border-border/70 bg-muted/20 p-4 flex items-start gap-3">
          <input
            id="published"
            type="checkbox"
            checked={published}
            onChange={(e) => setPublished(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border"
          />
          <div>
            <label htmlFor="published" className="text-sm font-medium text-foreground cursor-pointer">
              Publish to marketplace
            </label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Makes this product discoverable by affiliates in the public catalog. A URL slug will be auto-generated from the product name.
            </p>
            {published && name.trim() && (
              <p className="text-xs text-muted-foreground mt-1 font-mono">
                Slug: {slugify(name)}
              </p>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className={cn(PRIMARY_PILL, 'disabled:opacity-50 disabled:cursor-not-allowed')}
          >
            {submitting ? 'Creating…' : 'Create product'}
          </button>
          <button
            type="button"
            onClick={() => router.push(`/s/${slug}/products`)}
            className={GHOST_PILL}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
