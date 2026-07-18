/**
 * `log_email_sent` — record an email the seller sent OUTSIDE Cola.
 *
 * Approval-gated. Mutating: inserts a ContactActivity of type 'email'.
 * No delivery, no SMTP, no draft. This is purely for the audit trail.
 * The full body lands in metadata so it's preserved without bloating the
 * activity feed's `content` column.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';

const parameters = z
  .object({
    personId: z.string().min(1).describe('Contact.id this email was sent to.'),
    subject: z.string().trim().min(1).max(300).describe('Subject line.'),
    body: z.string().trim().min(1).max(10_000).describe('Body text — stored in metadata.'),
    sentAt: z.string().datetime().optional().describe('Optional ISO timestamp the email was sent. Defaults to now.'),
  })
  .describe('Log an email sent outside Cola to a contact. Audit trail only.');

interface LogEmailResult {
  contactId: string;
  activityId: string;
  sentAt: string;
}

export const logEmailSentTool = defineTool<typeof parameters, LogEmailResult>({
  name: 'log_email_sent',
  riskLevel: 'low',
  description:
    'Record an email the seller sent OUTSIDE Cola against a contact\'s timeline. Does NOT send anything.',
  parameters,
  requiresApproval: true,
  rateLimit: { max: 60, windowSeconds: 3600 },
  summariseCall(args) {
    return `Log email to contact ${args.personId.slice(0, 8)} — "${args.subject.slice(0, 60)}"`;
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
        type: 'email',
        content: `Sent: ${args.subject}`,
        metadata: { body: args.body, manualLog: true, sentAt, via: 'on_demand_agent' },
      });
    } catch (error) {
      logger.error('[tools.log_email_sent] insert failed', { contactId: c.id }, error);
      const message = error instanceof Error ? error.message : 'unknown error';
      return { summary: `Logging failed: ${message}`, display: 'error' };
    }

    return {
      summary: `Logged email to ${c.name}.`,
      data: { contactId: c.id, activityId, sentAt },
      display: 'success',
    };
  },
});
