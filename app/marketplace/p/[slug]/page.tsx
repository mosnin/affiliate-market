import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, Check, ExternalLink } from 'lucide-react';
import { getProductBySlug } from '@/lib/marketplace/products';
import { buildPromoCopy, mediaKitImages } from '@/lib/marketplace/media-kit';
import { BuyButton } from '@/components/marketplace/buy-button';
import { MediaKit } from '@/components/marketplace/media-kit';
import { OutboundLink } from '@/components/marketplace/outbound-link';
import { formatPriceCents } from '@/components/marketplace/price-format';
import { getInitials } from '@/lib/formatting';
import { TITLE_FONT } from '@/lib/typography';

export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) return { title: 'Not found — Cola Marketplace' };
  return {
    title: `${product.name} — Cola Marketplace`,
    description: product.tagline ?? `Buy ${product.name} from ${product.sellerName}.`,
    openGraph: {
      title: `${product.name} — Cola Marketplace`,
      description: product.tagline ?? undefined,
      images: product.logoUrl ? [product.logoUrl] : [],
    },
  };
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();

  const initials = getInitials(product.name);
  const price = formatPriceCents(product);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 pb-16 sm:px-6">
      {/* Back */}
      <Link
        href="/marketplace"
        className="mb-8 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={13} aria-hidden="true" />
        Marketplace
      </Link>

      <div className="grid gap-10 lg:grid-cols-[1fr_340px]">
        {/* Left: product content */}
        <div className="space-y-10">
          {/* Header */}
          <header className="flex items-start gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-muted">
              {product.logoUrl ? (
                <Image
                  src={product.logoUrl}
                  alt={`${product.name} logo`}
                  width={64}
                  height={64}
                  className="h-full w-full object-contain"
                />
              ) : (
                <span className="text-lg font-semibold text-muted-foreground">{initials}</span>
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <h1 className="text-3xl tracking-tight text-foreground" style={TITLE_FONT}>
                {product.name}
              </h1>
              {product.tagline && (
                <p className="text-sm text-muted-foreground">{product.tagline}</p>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {product.category && (
                  <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {product.category}
                  </span>
                )}
                {product.websiteUrl && (
                  <OutboundLink
                    href={product.websiteUrl}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ExternalLink size={11} aria-hidden="true" />
                    Website
                  </OutboundLink>
                )}
              </div>
            </div>
          </header>

          {/* Long description */}
          {product.longDescription && (
            <section className="space-y-3">
              <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                About this product
              </h2>
              <div className="prose prose-sm max-w-none text-foreground">
                {product.longDescription.split('\n').map((para, i) =>
                  para.trim() ? (
                    <p key={i} className="text-sm leading-relaxed text-foreground">
                      {para}
                    </p>
                  ) : null,
                )}
              </div>
            </section>
          )}

          {/* Features */}
          {product.features.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                What&apos;s included
              </h2>
              <ul className="space-y-2">
                {product.features.map((feature, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <Check size={14} className="mt-0.5 shrink-0 text-positive" aria-hidden="true" />
                    <span className="text-sm text-foreground">{feature}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Media kit for creators */}
          <MediaKit copy={buildPromoCopy(product)} images={mediaKitImages(product)} />

          {/* Vendor card */}
          <section className="space-y-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Sold by
            </h2>
            <div className="rounded-xl border border-border/70 bg-card p-4">
              <Link
                href={`/marketplace/v/${product.sellerSlug}`}
                className="text-sm font-medium text-foreground transition-colors hover:underline hover:underline-offset-2"
              >
                {product.sellerName}
              </Link>
              <p className="mt-1 text-xs text-muted-foreground">
                View all products from this seller.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  href={`/marketplace/v/${product.sellerSlug}`}
                  className="inline-flex h-7 items-center rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  Seller page
                </Link>
                <Link
                  href={`/book/${product.sellerSlug}`}
                  className="inline-flex h-7 items-center rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  Request a demo
                </Link>
              </div>
            </div>
          </section>
        </div>

        {/* Right: price box */}
        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
            <div className="mb-4 space-y-0.5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {product.pricingModel === 'subscription' ? 'Subscription' : 'One-time purchase'}
              </p>
              <p className="text-3xl font-semibold tracking-tight text-foreground" style={TITLE_FONT}>
                {price}
              </p>
              {product.pricingModel === 'subscription' && product.billingPeriod && (
                <p className="text-xs text-muted-foreground">
                  Billed {product.billingPeriod}
                </p>
              )}
            </div>

            {product.priceCents !== null ? (
              <BuyButton productId={product.id} productName={product.name} />
            ) : (
              <Link
                href={`/book/${product.sellerSlug}`}
                className="inline-flex w-full items-center justify-center rounded-full bg-foreground px-5 py-3 text-sm font-medium text-background transition-all duration-150 hover:bg-foreground/90 active:scale-[0.98]"
              >
                Contact seller
              </Link>
            )}

            <p className="mt-3 text-center text-[11px] text-muted-foreground">
              License delivered to your email instantly.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
