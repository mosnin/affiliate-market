/**
 * `log_meeting` — append an in-person meeting to the contact's audit trail.
 *
 * Same shape as log_call but type='meeting' and metadata.location instead of
 * sentiment/duration. Bumps lastContactedAt and reindexes search.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { syncContact } from '@/lib/vectorize';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';
import type { Contact } from '@/lib/types';

const parameters = z
  .object({
    personId: z.string().min(1).describe('The Contact.id the meeting was with.'),
    summary: z
      .string()
      .min(1)
      .max(5000)
      .describe('Plain-English summary of what happened in the meeting.'),
    location: z
      .string()
      .max(300)
      .optional()
      .describe('Where the meeting happened (address, café name, "Zoom", etc.).'),
  })
  .describe('Log an in-person or virtual meeting against a contact.');

interface LogMeetingResult {
  contactId: string;
  activityId: string;
}

export const logMeetingTool = defineTool<typeof parameters, LogMeetingResult>({
  name: 'log_meeting',
  riskLevel: 'low',
  description:
    "Log a meeting on a contact's timeline. Prompts for approval first.",
  parameters,
  requiresApproval: true,
  rateLimit: { max: 200, windowSeconds: 3600 },
  summariseCall(args) {
    const where = args.location ? ` at ${args.location}` : '';
    return `Log meeting${where} on contact ${args.personId.slice(0, 8)}`;
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

    const activityId = crypto.randomUUID();
    try {
      await convex().mutation(api.contacts.activity.create, {
        id: activityId,
        contactId: args.personId,
        spaceId: ctx.space.id,
        type: 'meeting',
        content: args.summary,
        metadata: {
          location: args.location ?? null,
          via: 'on_demand_agent',
        },
      });
    } catch (activityErr) {
      logger.error(
        '[tools.log_meeting] activity insert failed',
        { contactId: args.personId },
        activityErr,
      );
      const message = activityErr instanceof Error ? activityErr.message : 'unknown error';
      return { summary: `Couldn't log the meeting: ${message}`, display: 'error' };
    }

    // Bump lastContactedAt — non-fatal. The update returns the post-patch
    // row, which we reindex below.
    let refreshed: Contact | null = null;
    try {
      refreshed = (await convex().mutation(api.contacts.contacts.update, {
        id: args.personId,
        spaceId: ctx.space.id,
        patch: { lastContactedAt: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      })) as Contact | null;
    } catch (updateErr) {
      logger.warn(
        '[tools.log_meeting] lastContactedAt update failed',
        { contactId: args.personId },
        updateErr,
      );
    }

    if (refreshed) {
      syncContact(refreshed as Contact).catch((err) =>
        logger.warn('[tools.log_meeting] vector sync failed', { contactId: args.personId }, err),
      );
    }

    return {
      summary: `Logged meeting with ${contact.name || 'contact'}.`,
      data: { contactId: args.personId, activityId },
      display: 'success',
    };
  },
});
