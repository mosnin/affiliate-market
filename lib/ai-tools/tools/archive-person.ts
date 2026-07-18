/**
 * `archive_person` — push a contact out of the active People view.
 *
 * Approval-gated. The Contact table has no archivedAt column, but it does
 * have snoozedUntil — and the People list filters by it (see
 * /api/contacts/route.ts: `snoozedUntil.is.null,snoozedUntil.lte.now`).
 * Setting snoozedUntil to the far future is the existing archive
 * mechanism. The reason gets a 'note' line on the timeline.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';

// Year 9999 — same convention used elsewhere for "indefinite" timestamps.
const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

const parameters = z
  .object({
    personId: z.string().min(1).describe('The Contact.id to archive.'),
    reason: z
      .string()
      .min(1)
      .max(500)
      .describe('Why we are archiving this contact — recorded on the timeline.'),
  })
  .describe('Archive a contact (hide from the active People list).');

interface ArchivePersonResult {
  contactId: string;
}

export const archivePersonTool = defineTool<typeof parameters, ArchivePersonResult>({
  name: 'archive_person',
  riskLevel: 'destructive',
  description:
    "Archive a contact — hides them from the active People list. Reversible by clearing snoozedUntil. Prompts for approval first.",
  parameters,
  requiresApproval: true,
  rateLimit: { max: 60, windowSeconds: 3600 },
  summariseCall(args) {
    return `Archive contact ${args.personId.slice(0, 8)}`;
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
        patch: { snoozedUntil: FAR_FUTURE },
        updatedAt: new Date().toISOString(),
      });
    } catch (updateErr) {
      logger.error(
        '[tools.archive_person] update failed',
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
        content: `Archived: ${args.reason}`,
        metadata: { via: 'on_demand_agent', archive: true },
      });
    } catch (activityErr) {
      logger.warn(
        '[tools.archive_person] activity insert failed',
        { contactId: args.personId },
        activityErr,
      );
    }

    return {
      summary: `Archived ${contact.name || 'contact'}.`,
      data: { contactId: args.personId },
      display: 'success',
    };
  },
});
