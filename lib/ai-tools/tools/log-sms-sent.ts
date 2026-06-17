/**
 * `log_sms_sent` — record an SMS the seller sent OUTSIDE Cola.
 *
 * Approval-gated. Mutating: inserts a ContactActivity of type 'note' with
 * metadata.kind='sms' — the type CHECK enum is
 * ('note','call','email','meeting','follow_up') and SMS isn't there. We
 * preserve the channel via metadata so timeline rendering can distinguish.
 * No delivery — pure audit trail.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';

const parameters = z
  .object({
    personId: z.string().min(1).describe('Contact.id this SMS was sent to.'),
    body: z.string().trim().min(1).max(2_000).describe('Message body.'),
    sentAt: z.string().datetime().optional().describe('Optional ISO timestamp; defaults to now.'),
  })
  .describe('Log an SMS sent outside Cola to a contact. Audit trail only.');

interface LogSmsResult {
  contactId: string;
  activityId: string;
  sentAt: string;
}

export const logSmsSentTool = defineTool<typeof parameters, LogSmsResult>({
  name: 'log_sms_sent',
  riskLevel: 'low',
  description:
    'Record an SMS the seller sent OUTSIDE Cola against a contact\'s timeline. Does NOT send anything.',
  parameters,
  requiresApproval: true,
  rateLimit: { max: 60, windowSeconds: 3600 },
  summariseCall(args) {
    return `Log SMS to contact ${args.personId.slice(0, 8)} — "${args.body.slice(0, 60)}"`;
  },

  async handler(args, ctx) {
    let contact: { id: string; name: string } | null;
    try {
      contact = await convex().query(api.contacts.contacts.getById, {
        id: args.personId,
        spaceId: ctx.space.id,
      });
    } catch {
      contact = null;
    }
    if (!contact) {
      return { summary: 'Contact not found in this workspace.', display: 'error' };
    }
    const c = contact as { id: string; name: string };

    const sentAt = args.sentAt ?? new Date().toISOString();
    const activityId = crypto.randomUUID();
    try {
      await convex().mutation(api.contacts.activity.create, {
        id: activityId,
        contactId: c.id,
        spaceId: ctx.space.id,
        type: 'note',
        content: `Sent SMS: ${args.body.slice(0, 200)}`,
        metadata: { kind: 'sms', body: args.body, manualLog: true, sentAt, via: 'on_demand_agent' },
      });
    } catch (error) {
      logger.error('[tools.log_sms_sent] insert failed', { contactId: c.id }, error);
      const message = error instanceof Error ? error.message : 'unknown error';
      return { summary: `Logging failed: ${message}`, display: 'error' };
    }

    return {
      summary: `Logged SMS to ${c.name}.`,
      data: { contactId: c.id, activityId, sentAt },
      display: 'success',
    };
  },
});
