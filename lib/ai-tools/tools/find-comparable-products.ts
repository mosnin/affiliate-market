/**
 * `find_comparable_products` — search competing/similar Product rows in this workspace.
 *
 * Read-only. Looks at the seller's own saved products (catalog) to find
 * competing or similar software products for pricing analysis. Filters by
 * category, price range, and keyword. Used for competitive pricing analysis
 * (formerly CMA).
 *
 * Sort: when a price midpoint is computable from priceMin + priceMax (or one
 * of them), rank by ABS(price - midpoint). Otherwise default to recently
 * updated.
 */

import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { defineTool } from '../types';

const parameters = z
  .object({
    keyword: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Free-text keyword to ILIKE-match against product name, tagline, or category.'),
    category: z
      .string()
      .optional()
      .describe('Product category filter, e.g. "saas", "devtools", "api_service".'),
    priceMin: z.number().min(0).optional().describe('Minimum list price / monthly price in dollars.'),
    priceMax: z.number().min(0).optional().describe('Maximum list price / monthly price in dollars.'),
    status: z
      .enum(['draft', 'published', 'archived'])
      .optional()
      .describe("Product.listingStatus filter. Use 'published' for live catalog entries."),
  })
  .describe('Find up to 6 saved products matching the criteria. Searches the seller\'s own product catalog — not a public marketplace index.');

interface ProductMatch {
  id: string;
  name: string;
  category: string | null;
  listPrice: number | null;
  listingStatus: string;
  tagline: string | null;
}

interface FindCompsResult {
  products: ProductMatch[];
  note?: string;
}

export const findComparableProductsTool = defineTool<typeof parameters, FindCompsResult>({
  name: 'find_comparable_products',
  riskLevel: 'safe',
  description:
    'Search the seller\'s product catalog for competing or similar software products by keyword, category, and price range. Returns up to 6. Useful for competitive pricing analysis.',
  parameters,
  requiresApproval: false,

  async handler(args, ctx) {
    const all = await convex().query(api.marketplace.products.listForSpace, {
      spaceId: ctx.space.id,
      order: 'updated',
    });

    // The old query was spaceId-only (no assigned-pool OR) — keep that scope, then
    // apply the price/status/category/keyword filters in memory over the rows.
    let scoped = (all as Array<ProductMatch & { updatedAt: string; spaceId: string; address?: string }>).filter(
      (r) => r.spaceId === ctx.space.id,
    );
    if (args.priceMin != null) scoped = scoped.filter((r) => r.listPrice != null && r.listPrice >= args.priceMin!);
    if (args.priceMax != null) scoped = scoped.filter((r) => r.listPrice != null && r.listPrice <= args.priceMax!);
    if (args.status) scoped = scoped.filter((r) => r.listingStatus === args.status);
    if (args.category) scoped = scoped.filter((r) => r.category === args.category);
    if (args.keyword) {
      const needle = args.keyword.toLowerCase();
      scoped = scoped.filter((r) => {
        const name = (r.name as string | null)?.toLowerCase() ?? '';
        const address = (r.address as string | null | undefined)?.toLowerCase() ?? '';
        const tagline = (r.tagline as string | null)?.toLowerCase() ?? '';
        const category = (r.category as string | null)?.toLowerCase() ?? '';
        return name.includes(needle) || address.includes(needle) || tagline.includes(needle) || category.includes(needle);
      });
    }
    // small over-fetch to allow midpoint sort, matching the old `.limit(20)`.
    let rows = scoped.slice(0, 20);
    if (rows.length === 0) {
      return {
        summary: 'No comparable products on file.',
        data: { products: [], note: 'No comparable products in your catalog matching those criteria.' },
        display: 'plain',
      };
    }

    // Midpoint sort when we have a usable price band.
    const midpoint =
      args.priceMin != null && args.priceMax != null
        ? (args.priceMin + args.priceMax) / 2
        : args.priceMin ?? args.priceMax ?? null;
    if (midpoint != null) {
      rows = rows
        .filter((r) => r.listPrice != null)
        .sort((a, b) => Math.abs((a.listPrice ?? 0) - midpoint) - Math.abs((b.listPrice ?? 0) - midpoint));
    }
    rows = rows.slice(0, 6);

    const products: ProductMatch[] = rows.map((r) => ({
      id: r.id,
      name: r.name ?? r.address ?? 'Untitled',
      category: r.category,
      listPrice: r.listPrice,
      listingStatus: r.listingStatus,
      tagline: r.tagline,
    }));

    return {
      summary: `${products.length} comparable product${products.length === 1 ? '' : 's'} in your catalog.`,
      data: { products },
      display: 'plain',
    };
  },
});
