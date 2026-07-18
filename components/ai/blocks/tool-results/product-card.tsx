'use client';

import { useState, useEffect } from 'react';
import { Building2, ChevronRight, ChevronDown, MapPin, ImageOff } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';
import { CardSkeleton } from '../card-skeleton';
import { DURATION_BASE, EASE_IN_OUT } from '@/lib/motion';

function googleMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

/** Google Maps Static image — no geocoding step needed (the API accepts a
 *  raw address as the center). Gated on NEXT_PUBLIC_GOOGLE_MAPS_KEY; when
 *  unset the map slot is hidden and the "View on Maps" link in the actions
 *  row carries the navigation intent. */
const GMAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;

function staticMapUrl(address: string): string | null {
  if (!GMAPS_KEY) return null;
  const enc = encodeURIComponent(address);
  return `https://maps.googleapis.com/maps/api/staticmap?center=${enc}&zoom=15&size=640x240&scale=2&maptype=roadmap&markers=color:0xff5a1f%7C${enc}&key=${GMAPS_KEY}`;
}

interface ProductSummary {
  id: string;
  address: string;
  price?: number | null;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  listingStatus?: string;
}

interface ProductDetail {
  id: string;
  address: string;
  price: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  listingStatus: string;
  daysOnMarket: number | null;
  dealCount: number;
  description: string | null;
  photos?: string[];
}

interface ProductCardProps {
  product: ProductSummary;
  slug: string;
  animDelay?: number;
}

/** Format a price number into a compact string like "$450k" or "$1.2M". */
function formatPrice(v: number | null | undefined): string | null {
  if (v == null) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v)}`;
}

/** Format a price for the detail grid — full number with commas. */
function formatPriceFull(v: number | null): string {
  if (v == null) return '—';
  return `$${v.toLocaleString()}`;
}

function formatSqft(v: number | null | undefined): string | null {
  if (v == null) return null;
  return v.toLocaleString();
}

/** Icon background tone keyed by listingStatus. */
function iconBg(status: string | undefined): string {
  const s = (status ?? '').toLowerCase();
  if (s === 'active') return 'bg-positive-subtle0/10';
  if (s === 'pending') return 'bg-muted0/10';
  return 'bg-muted';
}

/** Status chip styling keyed by listingStatus. */
const STATUS_CHIP: Record<string, string> = {
  active:
    'text-positive bg-positive-subtle dark:text-positive dark:bg-positive-subtle0/15',
  pending:
    'text-muted-foreground bg-muted dark:text-muted-foreground dark:bg-muted0/15',
  sold: 'text-muted-foreground bg-muted',
  closed: 'text-muted-foreground bg-muted',
  withdrawn: 'text-muted-foreground bg-muted',
};

function statusChipClass(status: string | undefined): string {
  const key = (status ?? '').toLowerCase();
  return STATUS_CHIP[key] ?? 'text-muted-foreground bg-muted';
}

export function ProductCard({ product, slug, animDelay = 0 }: ProductCardProps) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || detail || loading) return;
    if (!slug) return;
    setLoading(true);
    fetch(`/api/cards/product/${product.id}?slug=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ProductDetail | null) => {
        if (d) setDetail(d);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [open, detail, loading, slug, product.id]);

  const compactPrice = formatPrice(product.price);
  const iconBgClass = iconBg(product.listingStatus);
  const chipClass = statusChipClass(product.listingStatus);

  // Sub-line: beds · baths · sqft
  const specs: string[] = [];
  if (product.beds != null) specs.push(`${product.beds} bd`);
  if (product.baths != null) specs.push(`${product.baths} ba`);
  if (product.sqft != null) specs.push(`${formatSqft(product.sqft)} sqft`);
  const specsLine = specs.join(' · ');

  return (
    <motion.div
      className="rounded-xl border border-border/60 bg-background overflow-hidden"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1], delay: animDelay }}
    >
      {/* Collapsed row */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group/row w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
      >
        {/* Building icon with status-tinted background */}
        <div
          className={cn(
            'w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0',
            iconBgClass,
          )}
        >
          <Building2 size={14} className="text-muted-foreground" />
        </div>

        {/* Address + specs sub-line */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate leading-tight">
            {product.address}
          </p>
          {specsLine && (
            <p className="text-[11px] text-muted-foreground mt-0.5">{specsLine}</p>
          )}
        </div>

        {/* Price + status chip + chevron */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {compactPrice && (
            <span className="text-[11px] tabular-nums text-foreground font-medium">
              {compactPrice}
            </span>
          )}
          {product.listingStatus && (
            <span
              className={cn(
                'inline-flex text-[10px] font-medium rounded-full px-2 py-0.5 whitespace-nowrap',
                chipClass,
              )}
            >
              {product.listingStatus}
            </span>
          )}
          {open ? (
            <ChevronDown size={13} className="text-muted-foreground/60" />
          ) : (
            <ChevronRight
              size={13}
              className="text-muted-foreground/0 group-hover/row:text-muted-foreground/60 transition-colors"
            />
          )}
        </div>
      </button>

      {/* Expanded detail panel */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: DURATION_BASE, ease: EASE_IN_OUT }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/40 bg-muted/20 px-4 py-4 space-y-4">
              {loading && <CardSkeleton rows={4} />}

              {!loading && detail && (
                <>
                  {/* Hero image — first photo if any. 16:9, object-cover so
                      the address line up top reads even with mismatched
                      aspect ratios. Falls back to a quiet placeholder when
                      no photo is attached. */}
                  <ProductHero photos={detail.photos ?? []} address={detail.address} />

                  {/* Static map preview — only rendered when
                      NEXT_PUBLIC_GOOGLE_MAPS_KEY is configured. Without a
                      key, the action-row "Open in Maps" link carries the
                      same intent. */}
                  <ProductMap address={detail.address} />

                  {/* Specs grid */}
                  <div className="grid grid-cols-2 gap-px rounded-lg overflow-hidden border border-border/60 bg-border/60 text-[12px]">
                    <div className="bg-background px-3 py-2 flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                        Price
                      </span>
                      <span className="text-foreground font-medium tabular-nums">
                        {formatPriceFull(detail.price)}
                      </span>
                    </div>
                    <div className="bg-background px-3 py-2 flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                        Status
                      </span>
                      <span
                        className={cn(
                          'self-start inline-flex text-[10px] font-medium rounded-full px-2 py-0.5',
                          statusChipClass(detail.listingStatus),
                        )}
                      >
                        {detail.listingStatus}
                      </span>
                    </div>
                    <div className="bg-background px-3 py-2 flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                        Beds
                      </span>
                      <span className="text-foreground tabular-nums">
                        {detail.beds ?? '—'}
                      </span>
                    </div>
                    <div className="bg-background px-3 py-2 flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                        Baths
                      </span>
                      <span className="text-foreground tabular-nums">
                        {detail.baths ?? '—'}
                      </span>
                    </div>
                    <div className="bg-background px-3 py-2 flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                        Sqft
                      </span>
                      <span className="text-foreground tabular-nums">
                        {detail.sqft != null ? detail.sqft.toLocaleString() : '—'}
                      </span>
                    </div>
                    <div className="bg-background px-3 py-2 flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                        DOM
                      </span>
                      <span className="text-foreground tabular-nums">
                        {detail.daysOnMarket != null
                          ? `${detail.daysOnMarket} days`
                          : '—'}
                      </span>
                    </div>
                    {detail.dealCount > 0 && (
                      <div className="bg-background px-3 py-2 col-span-2 flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                          Deals
                        </span>
                        <span className="text-foreground">
                          {detail.dealCount} active{' '}
                          {detail.dealCount === 1 ? 'deal' : 'deals'}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Description */}
                  {detail.description && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
                        Description
                      </p>
                      <p className="text-[12px] text-muted-foreground leading-relaxed line-clamp-4">
                        {detail.description}
                      </p>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-4 flex-wrap">
                    <a
                      href={`/s/${slug}/products/${product.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-foreground hover:text-muted-foreground transition-colors"
                    >
                      View Product
                      <ChevronRight size={12} />
                    </a>
                    <a
                      href={googleMapsUrl(detail.address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <MapPin size={12} />
                      Open in Maps
                    </a>
                  </div>
                </>
              )}

              {/* No detail loaded and not loading — fallback when fetch returned null */}
              {!loading && !detail && (
                <p className="text-[12px] text-muted-foreground">
                  Could not load product details.
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** Hero photo or quiet empty-state. Real estate is visual; lead with
 *  imagery the moment the seller opens a product card. */
function ProductHero({ photos, address }: { photos: string[]; address: string }) {
  const [errored, setErrored] = useState(false);
  const src = photos[0];
  if (!src || errored) {
    return (
      <div className="aspect-[16/9] w-full rounded-lg border border-border/40 bg-muted/40 flex items-center justify-center text-muted-foreground/60">
        <ImageOff size={20} aria-hidden />
      </div>
    );
  }
  return (
    <div className="relative aspect-[16/9] w-full rounded-lg overflow-hidden border border-border/40 bg-muted/20">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={address}
        className="w-full h-full object-cover"
        onError={() => setErrored(true)}
        loading="lazy"
      />
      {photos.length > 1 && (
        <span className="absolute bottom-2 right-2 text-[10px] font-medium bg-background/80 backdrop-blur-sm rounded-full px-2 py-0.5 text-foreground/80">
          +{photos.length - 1}
        </span>
      )}
    </div>
  );
}

/** Static map preview. Rendered only when NEXT_PUBLIC_GOOGLE_MAPS_KEY is
 *  set — the env-driven gate keeps the codebase free of vendor lock-in
 *  while shipping the rendering path. Falls back silently when no key. */
function ProductMap({ address }: { address: string }) {
  const [errored, setErrored] = useState(false);
  const url = staticMapUrl(address);
  if (!url || errored) return null;
  return (
    <a
      href={googleMapsUrl(address)}
      target="_blank"
      rel="noopener noreferrer"
      className="block relative aspect-[16/6] w-full rounded-lg overflow-hidden border border-border/40 group/map"
      aria-label={`Open ${address} in Google Maps`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={`Map of ${address}`}
        className="w-full h-full object-cover group-hover/map:scale-[1.01] transition-transform duration-300"
        onError={() => setErrored(true)}
        loading="lazy"
      />
      <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 text-[10px] font-medium bg-background/85 backdrop-blur-sm rounded-full px-2 py-0.5 text-foreground/80">
        <MapPin size={9} />
        Tap to open
      </span>
    </a>
  );
}
