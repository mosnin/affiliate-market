/**
 * `note_on_product` — append a dated note to Product.notes.
 *
 * Schema reality: Product has a single `notes TEXT` column (not an
 * activity table, not a jsonb array). The smallest defensible move is
 * to append `\n[YYYY-MM-DD] <content>` so notes stay human-readable
 * and chronological without a migration. If product notes ever need
 * structured activity, that's a separate Product.notes → ProductActivity
 * migration — not part of this tool.
 *
 * Approval-gated: notes ride along on the listing card; the seller
 * sees the text before it goes in.
 */

import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';

const parameters = z
  .object({
    productId: z.string().min(1).describe('The Product.id to note on.'),
    content: z.string().min(1).max(2000).describe('The note text.'),
  })
  .describe('Append a dated note to a product.');

interface NoteOnProductResult {
  productId: string;
  appendedLine: string;
}

export const noteOnProductTool = defineTool<typeof parameters, NoteOnProductResult>({
  name: 'note_on_product',
  riskLevel: 'low',
  description:
    "Add a note to a product's notes log. Prompts for approval first.",
  parameters,
  requiresApproval: true,
  rateLimit: { max: 60, windowSeconds: 3600 },
  summariseCall(args) {
    const preview = args.content.length > 60 ? args.content.slice(0, 57) + '…' : args.content;
    return `Note on product ${args.productId.slice(0, 8)}: ${preview}`;
  },

  async handler(args, ctx) {
    const product = await convex().query(api.marketplace.products.getByIdInSpace, {
      id: args.productId,
      spaceId: ctx.space.id,
    });
    if (!product) {
      return { summary: `No product with id "${args.productId}".`, display: 'error' };
    }

    const today = new Date().toISOString().slice(0, 10);
    const trimmed = args.content.trim();
    const appendedLine = `[${today}] ${trimmed}`;
    const existing = ((product.notes as string | null) ?? '').trim();
    const next = existing ? `${existing}\n${appendedLine}` : appendedLine;

    const updateRes = await convex().mutation(api.marketplace.products.update, {
      id: args.productId,
      spaceId: ctx.space.id,
      fields: { notes: next },
    });
    if (!updateRes.ok) {
      logger.error('[tools.note_on_product] update failed', { productId: args.productId, error: updateRes.error });
      return { summary: `Note save failed: ${updateRes.error}`, display: 'error' };
    }

    return {
      summary: `Note added to ${product.address}.`,
      data: { productId: product.id, appendedLine },
      display: 'success',
    };
  },
});
