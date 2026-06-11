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
import { supabase } from '@/lib/supabase';
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
    let query = supabase
      .from('Product')
      .select('id, name, address, category, listPrice, listingStatus, tagline, updatedAt')
      .eq('spaceId', ctx.space.id)
      .limit(20); // small over-fetch to allow midpoint sort

    if (args.priceMin != null) query = query.gte('listPrice', args.priceMin);
    if (args.priceMax != null) query = query.lte('listPrice', args.priceMax);
    if (args.status) query = query.eq('listingStatus', args.status);
    if (args.category) query = query.eq('category', args.category);
    if (args.keyword) {
      const escaped = args.keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/[,()]/g, '');
      const pat = `%${escaped}%`;
      query = query.or(`name.ilike.${pat},address.ilike.${pat},tagline.ilike.${pat},category.ilike.${pat}`);
    }
    query = query.order('updatedAt', { ascending: false });

    const { data, error } = await query.abortSignal(ctx.signal);
    if (error) {
      return { summary: `Product lookup failed: ${error.message}`, display: 'error' };
    }

    let rows = (data ?? []) as Array<ProductMatch & { updatedAt: string; address?: string }>;
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
