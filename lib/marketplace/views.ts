/**
 * Product-view tracking + the seller conversion funnel.
 *
 * The top of the funnel that the rest of the marketplace was missing. Three
 * concerns, one file:
 *   - recordProductView  — the write path (public beacon → here). Never throws.
 *   - getViewCountsForProducts — batched count, no N+1, for any product list.
 *   - getFunnelForSeller  — views ⨝ paid orders, per published product.
 *
 * Money note: this is SELLER-facing, so every dollar here is GROSS (gross
 * marketplace order amount). Creator net never appears in a funnel.
 */

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { getOrdersForSpace } from '@/lib/marketplace/orders';

export interface RecordProductViewInput {
  productId: string;
  visitorId: string | null;
  ipHash?: string | null;
}

/**
 * Append one product-view row. Resolves the owning spaceId from Product so the
 * funnel can scope by seller without a join. Best-effort: a tracking failure
 * must never surface to the visitor, so this swallows everything and returns
 * false instead of throwing. An unknown productId is noise, not an error.
 */
export async function recordProductView(input: RecordProductViewInput): Promise<boolean> {
  try {
    const productId = input.productId?.trim();
    if (!productId) return false;

    // Resolve owning space. A missing product → drop the view (the FK would
    // reject it anyway); we never want an orphan row or an exception here.
    const { data: product } = await supabase
      .from('Product')
      .select('id, spaceId')
      .eq('id', productId)
      .maybeSingle();
    if (!product) return false;

    const { error } = await supabase.from('ProductView').insert({
      spaceId: (product as { spaceId: string | null }).spaceId ?? null,
      productId: product.id,
      visitorId: input.visitorId ? input.visitorId.slice(0, 64) : null,
      ipHash: input.ipHash ?? null,
    });

    if (error) {
      logger.warn('[marketplace] product-view insert failed', { error: error.message });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('[marketplace] recordProductView failed', { err: String(err) });
    return false;
  }
}

/**
 * Total views per product, batched into one query. Returns a Map keyed by
 * productId; products with zero views are simply absent (callers default to 0).
 */
export async function getViewCountsForProducts(
  productIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return counts;

  // One round trip: pull the productId column for the set and tally in memory.
  // ProductView is intentionally thin, so the rows are tiny; this is cheaper
  // and simpler than a per-product count() fan-out and scales with the index.
  const { data, error } = await supabase
    .from('ProductView')
    .select('productId')
    .in('productId', ids);

  if (error) {
    logger.warn('[marketplace] view-count query failed', { error: error.message });
    return counts;
  }

  for (const row of (data ?? []) as { productId: string }[]) {
    counts.set(row.productId, (counts.get(row.productId) ?? 0) + 1);
  }
  return counts;
}

/** One published product's funnel row. Conversion is a 0–1 fraction. */
export interface ProductFunnelRow {
  productId: string;
  name: string;
  /** Tracked page views (top of funnel). */
  views: number;
  /** Paid marketplace orders (bottom of funnel). */
  sales: number;
  /** sales / views, clamped 0..1; 0 when there are no views. */
  conversionRate: number;
  /** Gross revenue from paid orders, in cents (seller-facing → gross). */
  revenueCents: number;
}

/**
 * The seller conversion funnel: every published, marketplace-listed product
 * with its views, paid sales, conversion, and gross revenue.
 *
 * Views come from ProductView (counted), sales + revenue from PAID
 * MarketplaceOrders (via getOrdersForSpace, filtered to status 'paid' so
 * pending/refunded/canceled never inflate the funnel). Products with no views
 * AND no sales are dropped — an unlisted or never-touched product is noise on a
 * funnel; the page's empty state covers the "nothing yet" case.
 */
export async function getFunnelForSeller(spaceId: string): Promise<ProductFunnelRow[]> {
  // Published, marketplace-listed products for this space — the only ones a
  // buyer can reach, so the only ones a funnel describes.
  const { data: products, error: prodErr } = await supabase
    .from('Product')
    .select('id, name, address')
    .eq('spaceId', spaceId)
    .eq('published', true)
    .not('marketplaceSlug', 'is', null);

  if (prodErr) {
    logger.warn('[marketplace] funnel product query failed', { error: prodErr.message });
    return [];
  }

  const rows = (products ?? []) as { id: string; name: string | null; address: string | null }[];
  if (rows.length === 0) return [];

  const productIds = rows.map((r) => r.id);

  // Views (batched) + paid orders (one space query) in parallel.
  const [viewCounts, orders] = await Promise.all([
    getViewCountsForProducts(productIds),
    getOrdersForSpace(spaceId),
  ]);

  // Fold paid orders into per-product sales + gross revenue.
  const salesByProduct = new Map<string, number>();
  const revenueByProduct = new Map<string, number>();
  for (const o of orders) {
    if (o.status !== 'paid') continue;
    salesByProduct.set(o.productId, (salesByProduct.get(o.productId) ?? 0) + 1);
    revenueByProduct.set(o.productId, (revenueByProduct.get(o.productId) ?? 0) + o.amountCents);
  }

  const funnel: ProductFunnelRow[] = rows.map((r) => {
    const views = viewCounts.get(r.id) ?? 0;
    const sales = salesByProduct.get(r.id) ?? 0;
    const revenueCents = revenueByProduct.get(r.id) ?? 0;
    const conversionRate = views > 0 ? Math.min(1, sales / views) : 0;
    return {
      productId: r.id,
      name: r.name ?? r.address ?? 'Untitled product',
      views,
      sales,
      conversionRate,
      revenueCents,
    };
  });

  // Drop products that have neither been seen nor sold — empty rows tell the
  // seller nothing. Then sort by views desc (the loudest listing first), with
  // sales as the tie-breaker.
  return funnel
    .filter((f) => f.views > 0 || f.sales > 0)
    .sort((a, b) => b.views - a.views || b.sales - a.sales);
}
