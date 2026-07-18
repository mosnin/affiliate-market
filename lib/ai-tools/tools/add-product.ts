/**
 * `add_product` — insert a Product row.
 *
 * Approval-gated: a new listing shows up on the product index immediately.
 * The seller confirms the address (and any optional details) before we
 * create the row.
 *
 * Mirrors the Python `add_product` in `agent/tools/products.py`. We keep
 * the field set narrow — the seller can fill the rest in the product page
 * after creation. Validation matches the DB CHECK constraints from
 * migration 20260425000000_product.sql.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';

const PRODUCT_TYPES = [
  'single_family',
  'condo',
  'townhouse',
  'multi_family',
  'land',
  'commercial',
  'other',
] as const;

const LISTING_STATUSES = ['active', 'pending', 'sold', 'off_market', 'owned'] as const;

const parameters = z
  .object({
    address: z.string().trim().min(1).max(500).describe('Street address line.'),
    listingStatus: z
      .enum(LISTING_STATUSES)
      .optional()
      .describe("Listing status. Defaults to 'active'."),
    listPrice: z
      .number()
      .nonnegative()
      .max(1_000_000_000)
      .optional()
      .describe('List price in dollars (no currency symbols).'),
    productType: z.enum(PRODUCT_TYPES).optional().describe('Product type.'),
    beds: z.number().nonnegative().max(99).optional(),
    baths: z.number().nonnegative().max(99).optional(),
    squareFeet: z.number().int().nonnegative().max(1_000_000).optional(),
    mlsNumber: z.string().trim().max(64).optional(),
    listingUrl: z.string().trim().url().max(2000).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .describe('Add a product to the workspace.');

interface AddProductResult {
  productId: string;
  address: string;
  listingStatus: string;
}

export const addProductTool = defineTool<typeof parameters, AddProductResult>({
  name: 'add_product',
  riskLevel: 'low',
  description:
    'Add a new product to the workspace. Captures address plus optional list price, beds/baths, MLS number. Prompts for approval first.',
  parameters,
  requiresApproval: true,
  rateLimit: { max: 30, windowSeconds: 3600 },
  summariseCall(args) {
    const addr = args?.address?.trim() || 'new address';
    return `Add product at ${addr}`;
  },

  async handler(args, ctx) {
    const productId = crypto.randomUUID();
    const status = args.listingStatus ?? 'active';
    const fields = {
      address: args.address.trim(),
      listingStatus: status,
      listPrice: args.listPrice ?? null,
      productType: args.productType ?? null,
      beds: args.beds ?? null,
      baths: args.baths ?? null,
      squareFeet: args.squareFeet ?? null,
      mlsNumber: args.mlsNumber?.trim() || null,
      listingUrl: args.listingUrl?.trim() || null,
      notes: args.notes?.trim() || null,
    };

    const res = await convex().mutation(api.marketplace.products.create, {
      id: productId,
      spaceId: ctx.space.id,
      fields,
    });
    if (!res.ok) {
      logger.error('[tools.add_product] insert failed', { address: fields.address, error: res.error });
      return { summary: `Couldn't add the product: ${res.error}`, display: 'error' };
    }

    return {
      summary: `Product added at ${fields.address}.`,
      data: { productId, address: fields.address, listingStatus: status },
      display: 'success',
    };
  },
});
