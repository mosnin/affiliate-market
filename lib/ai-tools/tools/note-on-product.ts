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
import { supabase } from '@/lib/supabase';
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
    const { data: product, error: fetchErr } = await supabase
      .from('Product')
      .select('id, address, notes')
      .eq('id', args.productId)
      .eq('spaceId', ctx.space.id)
      .maybeSingle();
    if (fetchErr) {
      return { summary: `Product lookup failed: ${fetchErr.message}`, display: 'error' };
    }
    if (!product) {
      return { summary: `No product with id "${args.productId}".`, display: 'error' };
    }

    const today = new Date().toISOString().slice(0, 10);
    const trimmed = args.content.trim();
    const appendedLine = `[${today}] ${trimmed}`;
    const existing = ((product.notes as string | null) ?? '').trim();
    const next = existing ? `${existing}\n${appendedLine}` : appendedLine;

    const { error: updateErr } = await supabase
      .from('Product')
      .update({ notes: next, updatedAt: new Date().toISOString() })
      .eq('id', args.productId)
      .eq('spaceId', ctx.space.id);
    if (updateErr) {
      logger.error('[tools.note_on_product] update failed', { productId: args.productId }, updateErr);
      return { summary: `Note save failed: ${updateErr.message}`, display: 'error' };
    }

    return {
      summary: `Note added to ${product.address}.`,
      data: { productId: product.id, appendedLine },
      display: 'success',
    };
  },
});
