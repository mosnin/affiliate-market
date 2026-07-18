/**
 * `attach_product_to_deal` — link an existing Product row to a Deal.
 *
 * Approval-gated: this is the kind of edit that quietly changes which
 * listing the deal is "about" — worth a single confirm tap.
 *
 * Both rows must belong to the caller's space (no cross-workspace links).
 */

import crypto from 'crypto';
import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { syncDeal } from '@/lib/vectorize';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';

const parameters = z
  .object({
    dealId: z.string().min(1).describe('The Deal.id to attach a product to.'),
    productId: z.string().min(1).describe('The Product.id to link.'),
  })
  .describe('Link a product to a deal so the deal card carries the listing.');

interface AttachProductResult {
  dealId: string;
  productId: string;
  address: string;
}

export const attachProductToDealTool = defineTool<typeof parameters, AttachProductResult>({
  name: 'attach_product_to_deal',
  riskLevel: 'low',
  description:
    'Link an existing product to a deal. Prompts for approval first.',
  parameters,
  requiresApproval: true,
  rateLimit: { max: 60, windowSeconds: 3600 },
  summariseCall(args) {
    return `Link product ${args.productId.slice(0, 8)} → deal ${args.dealId.slice(0, 8)}`;
  },

  async handler(args, ctx) {
    const { data: deal, error: dealErr } = await supabase
      .from('Deal')
      .select('id, title, productId')
      .eq('id', args.dealId)
      .eq('spaceId', ctx.space.id)
      .maybeSingle();
    if (dealErr) {
      return { summary: `Deal lookup failed: ${dealErr.message}`, display: 'error' };
    }
    if (!deal) {
      return { summary: `No deal with id "${args.dealId}".`, display: 'error' };
    }

    const product = await convex().query(api.marketplace.products.getByIdInSpace, {
      id: args.productId,
      spaceId: ctx.space.id,
    });
    if (!product) {
      return { summary: `No product with id "${args.productId}" in this workspace.`, display: 'error' };
    }

    if (deal.productId === product.id) {
      return {
        summary: `"${deal.title}" is already linked to ${product.address}.`,
        data: { dealId: deal.id, productId: product.id, address: product.address ?? '' },
        display: 'plain',
      };
    }

    const { error: updateErr } = await supabase
      .from('Deal')
      .update({ productId: product.id, updatedAt: new Date().toISOString() })
      .eq('id', args.dealId)
      .eq('spaceId', ctx.space.id);
    if (updateErr) {
      logger.error('[tools.attach_product_to_deal] update failed', { dealId: args.dealId }, updateErr);
      return { summary: `Link failed: ${updateErr.message}`, display: 'error' };
    }

    const { error: activityErr } = await supabase.from('DealActivity').insert({
      id: crypto.randomUUID(),
      dealId: args.dealId,
      spaceId: ctx.space.id,
      type: 'note',
      content: `Linked to product ${product.address}`,
      metadata: { productId: product.id, via: 'on_demand_agent' },
    });
    if (activityErr) {
      logger.warn('[tools.attach_product_to_deal] activity insert failed', { dealId: args.dealId }, activityErr);
    }

    const { data: refreshed } = await supabase
      .from('Deal')
      .select('*')
      .eq('id', args.dealId)
      .maybeSingle();
    if (refreshed) {
      syncDeal(refreshed).catch((err) =>
        logger.warn('[tools.attach_product_to_deal] vector sync failed', { dealId: args.dealId }, err),
      );
    }

    return {
      summary: `Linked "${deal.title}" → ${product.address}.`,
      data: { dealId: args.dealId, productId: product.id, address: product.address ?? '' },
      display: 'success',
    };
  },
});
