'use client';

/**
 * The activation step — list your first product.
 *
 * This is the payoff the whole seller onboarding was building toward. A
 * software seller who finishes onboarding without a PUBLISHED product leaves
 * the core loop dark: nothing on the marketplace, nothing for a creator to
 * grab a referral link to. So onboarding culminates here, in one live listing.
 *
 * Two presentation-agnostic pieces, reused by both the V2 conversational flow
 * (`onboarding-seller-v2.tsx`) and the V1 rollback flow (`onboarding-seller.tsx`):
 *
 *   ListingForm   — the minimum a marketplace listing needs: name (required),
 *                   tagline, category, pricing, 2–4 feature bullets, site URL.
 *   LivePayoff    — "You're live on the marketplace." The three doors that just
 *                   opened: the product page, the marketplace, the affiliates
 *                   program. Or, if they skipped, a quiet nudge to list later.
 *
 * The persistence contract is the EXISTING `POST /api/products` (protected,
 * unchanged). `buildListingPayload` is the single source of truth for the body
 * we send — pure, so the slugify + cents conversion is testable and identical
 * everywhere. The workspace `slug` it carries is the space the product belongs
 * to (set by `requireSpaceOwner` server-side); `marketplaceSlug` is the public
 * marketplace identity, slugified from the name.
 */

import { useMemo, useState } from 'react';
import { ArrowRight, Loader2, Plus, X, Check, Store, Users2, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PRODUCT_TYPE_OPTIONS } from '@/lib/products';
import type { ProductType } from '@/lib/types';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PricingModel = 'one_time' | 'subscription';
export type BillingPeriod = 'monthly' | 'yearly';

export interface ListingDraft {
  name: string;
  tagline: string;
  category: ProductType | '';
  pricingModel: PricingModel;
  /** Price in DOLLARS as the seller typed it. Converted to cents on submit. */
  priceDollars: string;
  billingPeriod: BillingPeriod;
  features: string[];
  websiteUrl: string;
}

export function emptyListingDraft(): ListingDraft {
  return {
    name: '',
    tagline: '',
    category: '',
    pricingModel: 'subscription',
    priceDollars: '',
    billingPeriod: 'monthly',
    features: ['', ''],
    websiteUrl: '',
  };
}

// ── Slug + payload (pure, the persistence contract) ────────────────────────────

/** Lowercase, hyphens, strip non-alphanumeric — the marketplace identity. */
export function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * Build the exact `POST /api/products` body for a published listing.
 *
 * `workspaceSlug` is the seller's space slug (auth + ownership). The product
 * goes live the moment it lands: `published: true` + `listingStatus: 'published'`.
 * Dollars → integer cents. Empty feature rows are dropped. Optional fields
 * collapse to omitted, not empty.
 *
 * `marketplaceSlug` (the public marketplace identity) is slugified from the
 * name and sent as the preferred slug. It is globally unique in the DB, so on
 * the rare name collision the caller retries with `omitSlug: true` and the
 * server mints a collision-proof one (`name-xxxxxx`). Either way the caller
 * reads the ACTUAL slug back off the response — never assume the sent value.
 */
export function buildListingPayload(
  draft: ListingDraft,
  workspaceSlug: string,
  opts: { omitSlug?: boolean } = {},
) {
  const name = draft.name.trim();
  const priceCents = dollarsToCents(draft.priceDollars);
  const features = draft.features.map((f) => f.trim()).filter(Boolean).slice(0, 4);

  return {
    slug: workspaceSlug,
    name,
    tagline: draft.tagline.trim() || undefined,
    category: draft.category || undefined,
    pricingModel: draft.pricingModel,
    priceCents: priceCents ?? undefined,
    currency: 'usd',
    billingPeriod: draft.pricingModel === 'subscription' ? draft.billingPeriod : undefined,
    features,
    websiteUrl: draft.websiteUrl.trim() || undefined,
    // Omitted on the collision retry so the server appends a unique suffix.
    marketplaceSlug: opts.omitSlug ? undefined : slugifyName(name),
    listingStatus: 'published' as const,
    published: true,
  };
}

/**
 * Publish the listing and return the slug the server actually stored.
 *
 * One round trip on the happy path. If the preferred slug collided (409 from
 * the unique index), retry once letting the server mint a unique suffix. The
 * returned `marketplaceSlug` is read off the persisted row — the only slug we
 * trust for the "view your listing" link. Throws on real failure.
 */
export async function publishProduct(
  draft: ListingDraft,
  workspaceSlug: string,
): Promise<{ marketplaceSlug: string }> {
  async function post(omitSlug: boolean) {
    return fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildListingPayload(draft, workspaceSlug, { omitSlug })),
    });
  }

  let res = await post(false);
  if (res.status === 409) res = await post(true); // slug taken → server mints one
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data?.error || 'publish failed');
  }
  const row = (await res.json().catch(() => ({}))) as { marketplaceSlug?: string | null };
  return { marketplaceSlug: row.marketplaceSlug ?? slugifyName(draft.name) };
}

/** "49" / "49.00" / "$1,299" → integer cents. Blank/garbage → null. */
export function dollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const dollars = Number.parseFloat(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

// ── The form ───────────────────────────────────────────────────────────────────

const INPUT_CLS =
  'w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-ring';

const SELECT_CLS =
  'w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

interface ListingFormProps {
  draft: ListingDraft;
  onChange: (next: ListingDraft) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
  onSkip: () => void;
}

/**
 * The listing fields. Name is the only required input — a seller can be live
 * with a name alone and fill in the rest from their workspace later. Pure
 * presentation: all state lives in the parent so both onboarding flows can own
 * persistence their own way.
 */
export function ListingForm({ draft, onChange, submitting, error, onSubmit, onSkip }: ListingFormProps) {
  const canSubmit = !submitting && draft.name.trim().length > 0;

  function set<K extends keyof ListingDraft>(key: K, value: ListingDraft[K]) {
    onChange({ ...draft, [key]: value });
  }

  function setFeature(i: number, value: string) {
    const next = draft.features.slice();
    next[i] = value;
    onChange({ ...draft, features: next });
  }

  function addFeature() {
    if (draft.features.length >= 4) return;
    onChange({ ...draft, features: [...draft.features, ''] });
  }

  function removeFeature(i: number) {
    if (draft.features.length <= 1) return;
    onChange({ ...draft, features: draft.features.filter((_, idx) => idx !== i) });
  }

  return (
    <div className="space-y-5">
      <div>
        <FieldLabel required>Product name</FieldLabel>
        <input
          type="text"
          autoFocus
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="Acme Analytics"
          maxLength={120}
          className={INPUT_CLS}
        />
      </div>

      <div>
        <FieldLabel>One-line pitch</FieldLabel>
        <input
          type="text"
          value={draft.tagline}
          onChange={(e) => set('tagline', e.target.value)}
          placeholder="The fastest way to ship product analytics."
          maxLength={200}
          className={INPUT_CLS}
        />
      </div>

      <div>
        <FieldLabel>Category</FieldLabel>
        <select
          value={draft.category}
          onChange={(e) => set('category', e.target.value as ListingDraft['category'])}
          className={SELECT_CLS}
        >
          <option value="">Pick a category</option>
          {PRODUCT_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Pricing — model picks the shape; price + period follow. */}
      <div>
        <FieldLabel>Pricing</FieldLabel>
        <div className="grid grid-cols-2 gap-2">
          <SegButton selected={draft.pricingModel === 'subscription'} onClick={() => set('pricingModel', 'subscription')}>
            Subscription
          </SegButton>
          <SegButton selected={draft.pricingModel === 'one_time'} onClick={() => set('pricingModel', 'one_time')}>
            One-time
          </SegButton>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="relative">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-base text-muted-foreground">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={draft.priceDollars}
              onChange={(e) => set('priceDollars', e.target.value.replace(/[^0-9.]/g, '').slice(0, 12))}
              placeholder="49"
              className={cn(INPUT_CLS, 'pl-7 tabular-nums')}
            />
          </div>
          {draft.pricingModel === 'subscription' ? (
            <select
              value={draft.billingPeriod}
              onChange={(e) => set('billingPeriod', e.target.value as BillingPeriod)}
              className={SELECT_CLS}
            >
              <option value="monthly">per month</option>
              <option value="yearly">per year</option>
            </select>
          ) : (
            <div className="flex items-center px-3.5 text-sm text-muted-foreground">one-time payment</div>
          )}
        </div>
      </div>

      {/* Feature bullets — 2 to 4. What a creator will repeat in a clip. */}
      <div>
        <FieldLabel>What it does — a few highlights</FieldLabel>
        <div className="space-y-2">
          {draft.features.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={f}
                onChange={(e) => setFeature(i, e.target.value)}
                placeholder={FEATURE_PLACEHOLDERS[i] ?? 'Another highlight'}
                maxLength={300}
                className={INPUT_CLS}
              />
              {draft.features.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeFeature(i)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="Remove highlight"
                >
                  <X size={15} />
                </button>
              )}
            </div>
          ))}
        </div>
        {draft.features.length < 4 && (
          <button
            type="button"
            onClick={addFeature}
            className="mt-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus size={14} /> Add a highlight
          </button>
        )}
      </div>

      <div>
        <FieldLabel>Website</FieldLabel>
        <input
          type="url"
          value={draft.websiteUrl}
          onChange={(e) => set('websiteUrl', e.target.value)}
          placeholder="https://acme.com"
          maxLength={1000}
          className={INPUT_CLS}
        />
      </div>

      {error && (
        <div className="rounded-xl border border-negative/20 bg-negative-subtle px-3 py-2.5 text-sm text-negative">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <button
          type="button"
          onClick={onSkip}
          disabled={submitting}
          className="text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:opacity-40"
        >
          Skip for now
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={onSubmit}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-5 h-9 text-sm font-semibold text-brand-foreground transition-all duration-150 hover:bg-brand/85 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <>Publish to the marketplace <ArrowRight size={14} /></>}
        </button>
      </div>
    </div>
  );
}

const FEATURE_PLACEHOLDERS = [
  'Real-time dashboards',
  'One-line SDK install',
  'Slack + webhook alerts',
  'Unlimited seats',
];

// ── The payoff ──────────────────────────────────────────────────────────────────

interface LivePayoffProps {
  /** The listed product's name (for the headline). */
  productName: string;
  /** The product's marketplace slug → its public page. */
  marketplaceSlug: string;
  /** The seller's workspace slug → /s/[slug]/affiliates. */
  workspaceSlug: string;
  submitting: boolean;
  onFinish: () => void;
}

/**
 * "You're live on the marketplace." The activation moment, in the seller's
 * own words — their product, by name, now sitting where creators look. Three
 * doors that just opened, then in to the dashboard.
 */
export function LivePayoff({ productName, marketplaceSlug, workspaceSlug, submitting, onFinish }: LivePayoffProps) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-subtle text-positive">
          <Check size={20} strokeWidth={2.5} />
        </span>
        <div>
          <p className="text-[17px] font-semibold leading-snug text-foreground">You&apos;re live on the marketplace.</p>
          <p className="text-sm text-muted-foreground">
            {productName.trim() ? `${productName.trim()} is published.` : 'Your product is published.'} Creators can now find it,
            grab a referral link, and promote it for you.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <PayoffLink
          href={`/marketplace/p/${marketplaceSlug}`}
          icon={<ExternalLink size={16} />}
          title="View your listing"
          subtitle="See exactly what a buyer sees."
        />
        <PayoffLink
          href="/marketplace"
          icon={<Store size={16} />}
          title="Browse the marketplace"
          subtitle="Where your product now appears."
        />
        <PayoffLink
          href={`/s/${workspaceSlug}/affiliates`}
          icon={<Users2 size={16} />}
          title="Your affiliate program"
          subtitle="Set commission, approve creators, track payouts."
        />
      </div>

      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={onFinish}
          disabled={submitting}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-6 h-10 text-sm font-semibold text-brand-foreground transition-all duration-150 hover:bg-brand/85 active:scale-[0.98] disabled:opacity-40"
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <>Take me to my dashboard <ArrowRight size={14} /></>}
        </button>
      </div>
    </div>
  );
}

/**
 * The skipped variant — onboarding still completes, but the loop is dark until
 * they list. A quiet, honest nudge, not a guilt trip.
 */
export function ListLaterNudge({ submitting, onFinish }: { submitting: boolean; onFinish: () => void }) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-[17px] font-semibold leading-snug text-foreground">No problem — list when you&apos;re ready.</p>
        <p className="text-sm text-muted-foreground">
          Your marketplace stays empty until your first product is published. When you are ready, add one from
          Products and it goes live for creators to promote.
        </p>
      </div>
      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={onFinish}
          disabled={submitting}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-6 h-10 text-sm font-semibold text-brand-foreground transition-all duration-150 hover:bg-brand/85 active:scale-[0.98] disabled:opacity-40"
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <>Take me to my dashboard <ArrowRight size={14} /></>}
        </button>
      </div>
    </div>
  );
}

function PayoffLink({
  href, icon, title, subtitle,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-all duration-150 hover:border-primary/40"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-subtle text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">{subtitle}</span>
      </span>
      <ArrowRight size={15} className="shrink-0 text-muted-foreground" />
    </a>
  );
}

// ── Bits ────────────────────────────────────────────────────────────────────────

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <p className="mb-1.5 text-xs font-medium text-muted-foreground">
      {children}{required ? <span className="text-negative"> *</span> : null}
    </p>
  );
}

function SegButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-xl border px-4 py-2.5 text-sm font-medium transition-all duration-150',
        selected
          ? 'border-primary bg-brand-subtle/50 text-primary'
          : 'border-border bg-card text-foreground hover:border-primary/40',
      )}
    >
      {children}
    </button>
  );
}
