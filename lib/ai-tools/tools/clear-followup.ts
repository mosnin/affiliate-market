/**
 * `clear_followup` — drop the scheduled follow-up on a contact.
 *
 * Approval-gated because clearing a follow-up makes the contact disappear
 * from the Today inbox, and the seller should sign off on that. The model
 * has to say WHY — that line goes into the activity log so the next
 * person looking at the contact can see what happened.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';

const parameters = z
  .object({
    personId: z.string().min(1).describe('The Contact.id to clear the follow-up on.'),
    why: z
      .string()
      .min(1)
      .max(500)
      .describe('Why we are clearing this follow-up — gets written to the timeline.'),
  })
  .describe('Clear a contact\'s scheduled follow-up.');

interface ClearFollowupResult {
  contactId: string;
}

export const clearFollowupTool = defineTool<typeof parameters, ClearFollowupResult>({
  name: 'clear_followup',
  riskLevel: 'low',
  description:
    "Clear a contact's scheduled follow-up. Requires a reason — it goes on the timeline. Prompts for approval first.",
  parameters,
  requiresApproval: true,
  rateLimit: { max: 200, windowSeconds: 3600 },
  summariseCall(args) {
    return `Clear follow-up on contact ${args.personId.slice(0, 8)}`;
  },

  async handler(args, ctx) {
    let contact: { id: string; name: string; companyId: string | null } | null;
    try {
      contact = await convex().query(api.contacts.contacts.getById, {
        id: args.personId,
        spaceId: ctx.space.id,
      });
    } catch (lookupErr) {
      const message = lookupErr instanceof Error ? lookupErr.message : 'unknown error';
      return { summary: `Contact lookup failed: ${message}`, display: 'error' };
    }
    // Preserve the `.is('companyId', null)` workspace-only filter.
    if (!contact || contact.companyId !== null) {
      return {
        summary: `No contact with id "${args.personId}" in this workspace.`,
        display: 'error',
      };
    }

    try {
      await convex().mutation(api.contacts.contacts.update, {
        id: args.personId,
        spaceId: ctx.space.id,
        patch: { followUpAt: null },
        updatedAt: new Date().toISOString(),
      });
    } catch (updateErr) {
      logger.error(
        '[tools.clear_followup] update failed',
        { contactId: args.personId },
        updateErr,
      );
      const message = updateErr instanceof Error ? updateErr.message : 'unknown error';
      return { summary: `Update failed: ${message}`, display: 'error' };
    }

    try {
      await convex().mutation(api.contacts.activity.create, {
        id: crypto.randomUUID(),
        contactId: args.personId,
        spaceId: ctx.space.id,
        type: 'note',
        content: `Follow-up cleared: ${args.why}`,
        metadata: { via: 'on_demand_agent' },
      });
    } catch (activityErr) {
      logger.warn(
        '[tools.clear_followup] activity insert failed',
        { contactId: args.personId },
        activityErr,
      );
    }

    return {
      summary: `Cleared follow-up on ${contact.name || 'contact'}.`,
      data: { contactId: args.personId },
      display: 'success',
    };
  },
});
