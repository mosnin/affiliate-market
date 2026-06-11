/**
 * `update_product_status` — flip a Product's listing status.
 *
 * Approval-gated: the listing status drives the product card label and
 * filters across the product index — a wrong flip ("sold" instead of
 * "pending") is visible immediately to the seller and to anyone with
 * a share link.
 *
 * Allowed statuses come from the DB CHECK constraint on
 * Product.listingStatus (see migration 20260425000000_product.sql):
 *   active | pending | sold | off_market | owned
 */

import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';

const ALLOWED = ['active', 'pending', 'sold', 'off_market', 'owned'] as const;

const parameters = z
  .object({
    productId: z.string().min(1).describe('The Product.id to update.'),
    newStatus: z.enum(ALLOWED).describe('New listing status.'),
    why: z.string().max(500).optional(),
  })
  .describe("Update a product's listing status.");

interface UpdateProductStatusResult {
  productId: string;
  oldStatus: string;
  newStatus: string;
}

export const updateProductStatusTool = defineTool<typeof parameters, UpdateProductStatusResult>({
  name: 'update_product_status',
  riskLevel: 'low',
  description:
    "Update a product's listing status (active, pending, sold, off_market, owned). Prompts for approval first.",
  parameters,
  requiresApproval: true,
  rateLimit: { max: 60, windowSeconds: 3600 },
  summariseCall(args) {
    const why = args.why ? ` — ${args.why}` : '';
    return `Set product ${args.productId.slice(0, 8)} → ${args.newStatus}${why}`;
  },

  async handler(args, ctx) {
    const { data: product, error: fetchErr } = await supabase
      .from('Product')
      .select('id, address, listingStatus')
      .eq('id', args.productId)
      .eq('spaceId', ctx.space.id)
      .maybeSingle();
    if (fetchErr) {
      return { summary: `Product lookup failed: ${fetchErr.message}`, display: 'error' };
    }
    if (!product) {
      return { summary: `No product with id "${args.productId}".`, display: 'error' };
    }

    const oldStatus = (product.listingStatus as string) || 'active';
    if (oldStatus === args.newStatus) {
      return {
        summary: `${product.address} is already ${args.newStatus}.`,
        data: { productId: product.id, oldStatus, newStatus: args.newStatus },
        display: 'plain',
      };
    }

    const { error: updateErr } = await supabase
      .from('Product')
      .update({ listingStatus: args.newStatus, updatedAt: new Date().toISOString() })
      .eq('id', args.productId)
      .eq('spaceId', ctx.space.id);
    if (updateErr) {
      logger.error('[tools.update_product_status] update failed', { productId: args.productId }, updateErr);
      return { summary: `Update failed: ${updateErr.message}`, display: 'error' };
    }

    return {
      summary: `${product.address} → ${args.newStatus}.`,
      data: { productId: product.id, oldStatus, newStatus: args.newStatus },
      display: 'success',
    };
  },
});
