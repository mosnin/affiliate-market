/**
 * `find_product` — read-only lookup over the Product table.
 *
 * Search by address (ILIKE), exact id, or listing status. Single match
 * returns rich detail; otherwise a list capped at 8.
 */

import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import { defineTool } from '../types';

const parameters = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Free-text search across address, city, MLS number, or exact id.'),
    status: z
      .enum(['active', 'pending', 'sold', 'off_market', 'owned'])
      .optional()
      .describe('Filter by listing status.'),
  })
  .refine((v) => v.query || v.status, { message: 'Provide at least one of query or status.' })
  .describe('Find a product by address, id, MLS number, or status.');

interface ProductHit {
  id: string;
  address: string;
  city: string | null;
  status: string;
  mlsNumber: string | null;
  listPrice: number | null;
  beds: number | null;
  baths: number | null;
  squareFeet: number | null;
}

interface FindProductResult {
  match: 'single' | 'shortlist' | 'none';
  product?: ProductHit;
  products?: ProductHit[];
}

const SELECT = 'id, address, city, listingStatus, mlsNumber, listPrice, beds, baths, squareFeet';

function toHit(row: Record<string, unknown>): ProductHit {
  return {
    id: row.id as string,
    address: row.address as string,
    city: (row.city as string | null) ?? null,
    status: (row.listingStatus as string) ?? 'active',
    mlsNumber: (row.mlsNumber as string | null) ?? null,
    listPrice: (row.listPrice as number | null) ?? null,
    beds: (row.beds as number | null) ?? null,
    baths: (row.baths as number | null) ?? null,
    squareFeet: (row.squareFeet as number | null) ?? null,
  };
}

function summariseOne(p: ProductHit): string {
  const parts: string[] = [p.address];
  if (p.city) parts.push(p.city);
  const bits: string[] = [];
  if (p.beds != null) bits.push(`${p.beds}bd`);
  if (p.baths != null) bits.push(`${p.baths}ba`);
  if (p.squareFeet != null) bits.push(`${p.squareFeet.toLocaleString('en-US')} sqft`);
  if (p.listPrice != null) bits.push(`$${Math.round(p.listPrice).toLocaleString('en-US')}`);
  bits.push(p.status);
  return `${parts.join(', ')} — ${bits.join(' · ')}`;
}

export const findProductTool = defineTool<typeof parameters, FindProductResult>({
  name: 'find_product',
  riskLevel: 'safe',
  description:
    "Find a product by address, MLS number, id, or status. Returns rich detail for a single match or a shortlist (≤8) when ambiguous.",
  parameters,
  requiresApproval: false,

  async handler(args, ctx) {
    // Exact id hit short-circuits the search.
    if (args.query) {
      const { data: byId } = await supabase
        .from('Product')
        .select(SELECT)
        .eq('id', args.query)
        .eq('spaceId', ctx.space.id)
        .maybeSingle();
      if (byId) {
        const hit = toHit(byId as Record<string, unknown>);
        return {
          summary: summariseOne(hit),
          data: { match: 'single' as const, product: hit },
          display: 'plain',
        };
      }
    }

    let query = supabase
      .from('Product')
      .select(SELECT)
      .eq('spaceId', ctx.space.id)
      .order('updatedAt', { ascending: false })
      .limit(8);

    if (args.status) query = query.eq('listingStatus', args.status);
    if (args.query) {
      const escaped = args.query
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_')
        .replace(/[,()]/g, '');
      const pat = `%${escaped}%`;
      query = query.or(`address.ilike.${pat},city.ilike.${pat},mlsNumber.ilike.${pat}`);
    }

    const { data, error } = await query.abortSignal(ctx.signal);
    if (error) {
      return {
        summary: `Product lookup failed: ${error.message}`,
        data: { match: 'none' as const },
        display: 'error',
      };
    }

    const rows = (data ?? []) as Record<string, unknown>[];
    if (rows.length === 0) {
      return {
        summary: 'No products matched.',
        data: { match: 'none' as const },
        display: 'plain',
      };
    }

    if (rows.length === 1) {
      const hit = toHit(rows[0]);
      return {
        summary: summariseOne(hit),
        data: { match: 'single' as const, product: hit },
        display: 'plain',
      };
    }

    const products = rows.map(toHit);
    const lines = products.map((p) => `• ${summariseOne(p)}`).join('\n');
    return {
      summary: `Found ${products.length} products:\n${lines}`,
      data: { match: 'shortlist' as const, products },
      display: 'plain',
    };
  },
});
