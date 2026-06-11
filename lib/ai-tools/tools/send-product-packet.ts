/**
 * `send_product_packet` — log the intent to share a product packet.
 *
 * Approval-gated. **Does NOT send anything.** This tool only writes a
 * ContactActivity row tagged with `kind: 'product_packet'` so the
 * seller's audit trail records that the agent queued the packet. The
 * actual delivery (email pipeline, etc.) is fired elsewhere — the agent
 * never moves bytes over the wire.
 *
 * The Python equivalent in `agent/tools/products.py` creates a real
 * AgentDraft + builds the share URL. The TS chat agent uses the SDK
 * approval flow for messaging tools, so this verb's job is to leave a
 * paper trail that "Cola proposed sending a packet for X to Y."
 */

import crypto from 'crypto';
import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';

const parameters = z
  .object({
    contactId: z.string().min(1).describe('The Contact.id to share the packet with.'),
    productId: z.string().min(1).describe('The Product.id to share.'),
    intent: z
      .string()
      .trim()
      .max(280)
      .optional()
      .describe('Short intent string for the audit log (defaults to "standard").'),
  })
  .describe('Queue a product packet share to a contact.');

interface SendProductPacketResult {
  contactId: string;
  productId: string;
  activityId: string;
  status: 'queued';
}

export const sendProductPacketTool = defineTool<typeof parameters, SendProductPacketResult>({
  name: 'send_product_packet',
  riskLevel: 'high',
  description:
    "Queue a product packet share to a contact (logs intent — actual send fires through the email pipeline). Prompts for approval first.",
  parameters,
  requiresApproval: true,
  rateLimit: { max: 60, windowSeconds: 3600 },
  summariseCall(args) {
    const c =
      typeof args?.contactId === 'string' && args.contactId.length > 0
        ? args.contactId.slice(0, 8)
        : 'contact';
    const p =
      typeof args?.productId === 'string' && args.productId.length > 0
        ? args.productId.slice(0, 8)
        : 'product';
    return `Send product packet for ${p} to ${c}`;
  },

  async handler(args, ctx) {
    const { data: contact, error: contactErr } = await supabase
      .from('Contact')
      .select('id, name')
      .eq('id', args.contactId)
      .eq('spaceId', ctx.space.id)
      .maybeSingle();
    if (contactErr) {
      return { summary: `Contact lookup failed: ${contactErr.message}`, display: 'error' };
    }
    if (!contact) {
      return { summary: `No contact with id "${args.contactId}".`, display: 'error' };
    }

    const { data: product, error: productErr } = await supabase
      .from('Product')
      .select('id, address')
      .eq('id', args.productId)
      .eq('spaceId', ctx.space.id)
      .maybeSingle();
    if (productErr) {
      return { summary: `Product lookup failed: ${productErr.message}`, display: 'error' };
    }
    if (!product) {
      return { summary: `No product with id "${args.productId}".`, display: 'error' };
    }

    const intent = args.intent?.trim() || 'standard';
    const activityId = crypto.randomUUID();
    const { error: activityErr } = await supabase.from('ContactActivity').insert({
      id: activityId,
      contactId: args.contactId,
      spaceId: ctx.space.id,
      type: 'note',
      content: `Queued product packet for ${product.address} (${intent}).`,
      metadata: {
        kind: 'product_packet',
        productId: args.productId,
        status: 'queued',
        intent,
        via: 'on_demand_agent',
      },
    });
    if (activityErr) {
      logger.error(
        '[tools.send_product_packet] activity insert failed',
        { contactId: args.contactId, productId: args.productId },
        activityErr,
      );
      return {
        summary: `Couldn't queue the packet: ${activityErr.message}`,
        display: 'error',
      };
    }

    return {
      summary: `Queued product packet for ${product.address} to ${contact.name || 'contact'}.`,
      data: {
        contactId: args.contactId,
        productId: args.productId,
        activityId,
        status: 'queued',
      },
      display: 'success',
    };
  },
});
