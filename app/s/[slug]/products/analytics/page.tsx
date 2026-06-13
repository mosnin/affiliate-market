import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { ArrowLeft, Eye, ShoppingBag, Percent, DollarSign, BarChart3 } from 'lucide-react';
import { getSpaceFromSlug, getSpaceForUser } from '@/lib/space';
import { getFunnelForSeller, type ProductFunnelRow } from '@/lib/marketplace/views';
import { formatCurrency } from '@/lib/formatting';
import {
  H1,
  TITLE_FONT,
  BODY_MUTED,
  STAT_CARD,
  STAT_NUMBER_COMPACT,
  SECTION_LABEL,
  ICON_SQUARE,
  CARD,
  CHIP_POSITIVE,
  CHIP_NEUTRAL,
  PAGE_RHYTHM,
  PRIMARY_PILL,
} from '@/lib/typography';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** sales/views as a tidy percent string. "—" when there's nothing to divide. */
function pct(rate: number, hasViews: boolean): string {
  if (!hasViews) return '—';
  const p = rate * 100;
  // One decimal under 10%, whole numbers above — the small conversions are
  // where the decimal actually matters.
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

export default async function ProductAnalyticsPage({
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

  const funnel = await getFunnelForSeller(space.id);

  // Roll the per-product rows up to the headline. Conversion is computed on the
  // totals (total sales / total views), not an average of per-product rates —
  // that's the honest overall number.
  const totalViews = funnel.reduce((s, r) => s + r.views, 0);
  const totalSales = funnel.reduce((s, r) => s + r.sales, 0);
  const totalRevenueCents = funnel.reduce((s, r) => s + r.revenueCents, 0);
  const overallRate = totalViews > 0 ? totalSales / totalViews : 0;
  const hasData = funnel.length > 0;

  return (
    <div className={cn(PAGE_RHYTHM, 'mx-auto max-w-5xl pb-12')}>
      {/* Header — back to the product list, then the one idea: does the
          listing convert? The H1 is plain; the conversion rate carries the
          emotion, and it lives in the stat row below as the focal number. */}
      <header className="space-y-1.5">
        <Link
          href={`/s/${slug}/products`}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={13} aria-hidden />
          Products
        </Link>
        <h1 className={H1} style={TITLE_FONT}>
          Product funnel
        </h1>
        <p className={cn(BODY_MUTED)}>
          {hasData
            ? 'Views to sales, per listing. Where attention turns into revenue — and where it leaks.'
            : 'How each listing turns views into sales.'}
        </p>
      </header>

      {/* Stat row — the funnel as four numbers. Views in, sales out,
          conversion between them, revenue earned. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={<Eye size={16} aria-hidden />}
          label="Product views"
          value={totalViews.toLocaleString('en-US')}
        />
        <StatCard
          icon={<ShoppingBag size={16} aria-hidden />}
          label="Sales"
          value={totalSales.toLocaleString('en-US')}
        />
        <StatCard
          icon={<Percent size={16} aria-hidden />}
          label="Conversion"
          value={pct(overallRate, totalViews > 0)}
        />
        <StatCard
          icon={<DollarSign size={16} aria-hidden />}
          label="Revenue"
          value={formatCurrency(totalRevenueCents / 100)}
        />
      </div>

      {/* Per-product funnel table, or the empty state. */}
      {hasData ? (
        <FunnelTable rows={funnel} />
      ) : (
        <EmptyState slug={slug} />
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className={cn(STAT_CARD)}>
      <div className={cn(ICON_SQUARE)}>{icon}</div>
      <p className={cn(BODY_MUTED)}>{label}</p>
      <p className={cn(STAT_NUMBER_COMPACT)} style={TITLE_FONT}>
        {value}
      </p>
    </div>
  );
}

function FunnelTable({ rows }: { rows: ProductFunnelRow[] }) {
  return (
    <div className={cn(CARD, 'overflow-hidden')}>
      {/* Column header */}
      <div
        className={cn(
          'hidden sm:grid grid-cols-[minmax(0,2fr)_90px_70px_90px_110px] px-5 py-2.5 bg-muted/40',
          SECTION_LABEL,
        )}
      >
        <span>Product</span>
        <span className="text-right">Views</span>
        <span className="text-right">Sales</span>
        <span className="text-right">Conv.</span>
        <span className="text-right">Revenue</span>
      </div>

      <div className="divide-y divide-border/60">
        {rows.map((r) => {
          const hasViews = r.views > 0;
          // A sale with zero recorded views (bought via a path that skipped the
          // beacon) reads as neutral, not a real conversion rate.
          const converts = hasViews && r.sales > 0;
          return (
            <div
              key={r.productId}
              className="grid grid-cols-2 sm:grid-cols-[minmax(0,2fr)_90px_70px_90px_110px] sm:items-center px-5 py-3 transition-colors hover:bg-muted/30"
            >
              {/* Product name — spans on mobile, first column on desktop */}
              <p className="col-span-2 sm:col-span-1 text-sm font-medium text-foreground truncate">
                {r.name}
              </p>

              <span className="hidden sm:block text-right text-sm tabular-nums text-foreground">
                {r.views.toLocaleString('en-US')}
              </span>
              <span className="hidden sm:block text-right text-sm tabular-nums text-muted-foreground">
                {r.sales.toLocaleString('en-US')}
              </span>
              <span className="hidden sm:flex justify-end">
                <span className={cn(converts ? CHIP_POSITIVE : CHIP_NEUTRAL)}>
                  {pct(r.conversionRate, hasViews)}
                </span>
              </span>
              <span className="hidden sm:block text-right text-sm tabular-nums font-semibold text-foreground">
                {formatCurrency(r.revenueCents / 100)}
              </span>

              {/* Mobile: a compact facts line under the name */}
              <div className="col-span-2 mt-1.5 flex items-center gap-3 text-xs text-muted-foreground sm:hidden">
                <span className="tabular-nums">{r.views.toLocaleString('en-US')} views</span>
                <span className="tabular-nums">{r.sales.toLocaleString('en-US')} sold</span>
                <span className={cn(converts ? CHIP_POSITIVE : CHIP_NEUTRAL)}>
                  {pct(r.conversionRate, hasViews)}
                </span>
                <span className="ml-auto tabular-nums font-semibold text-foreground">
                  {formatCurrency(r.revenueCents / 100)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmptyState({ slug }: { slug: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-5 py-12 text-center">
      <BarChart3 size={28} className="mx-auto mb-3 text-muted-foreground/60" aria-hidden />
      <p className="text-sm text-foreground">No views yet.</p>
      <p className={cn('mt-1 text-xs', BODY_MUTED)}>
        Publish a product to the marketplace and the funnel fills in as buyers open it.
      </p>
      <Link
        href={`/s/${slug}/products`}
        className={cn(PRIMARY_PILL, 'mt-4 inline-flex items-center gap-1.5')}
      >
        View products
      </Link>
    </div>
  );
}
