/**
 * `mark_person_cold` — demote a contact to the cold tier.
 *
 * Approval-gated. Sets scoreLabel='cold' and clamps leadScore down to 30 if
 * it was higher (preserves anything already lower). Logs the reason.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { syncContact } from '@/lib/vectorize';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';
import type { Contact } from '@/lib/types';

const COLD_CEILING = 30;

const parameters = z
  .object({
    personId: z.string().min(1).describe('The Contact.id to mark cold.'),
    why: z
      .string()
      .min(1)
      .max(500)
      .describe('Why this person is cold — recorded on the timeline.'),
  })
  .describe('Mark a contact as a cold lead.');

interface MarkColdResult {
  contactId: string;
  leadScore: number;
}

export const markPersonColdTool = defineTool<typeof parameters, MarkColdResult>({
  name: 'mark_person_cold',
  riskLevel: 'low',
  description:
    "Mark a contact as a cold lead. Tags scoreLabel='cold' and clamps lead score downward. Prompts for approval first.",
  parameters,
  requiresApproval: true,
  rateLimit: { max: 100, windowSeconds: 3600 },
  summariseCall(args) {
    return `Mark contact ${args.personId.slice(0, 8)} as cold`;
  },

  async handler(args, ctx) {
    let contact: { id: string; name: string; leadScore: number | null; companyId: string | null } | null;
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

    const current = contact.leadScore ?? COLD_CEILING;
    const newScore = current > COLD_CEILING ? COLD_CEILING : current;

    let refreshed: Contact | null = null;
    try {
      refreshed = (await convex().mutation(api.contacts.contacts.update, {
        id: args.personId,
        spaceId: ctx.space.id,
        patch: {
          scoreLabel: 'cold',
          leadScore: newScore,
          scoringStatus: 'scored',
        },
        updatedAt: new Date().toISOString(),
      })) as Contact | null;
    } catch (updateErr) {
      logger.error(
        '[tools.mark_person_cold] update failed',
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
        type: 'status_change',
        content: `Marked cold: ${args.why}`,
        metadata: { scoreLabel: 'cold', leadScore: newScore, via: 'on_demand_agent' },
      });
    } catch (activityErr) {
      logger.warn(
        '[tools.mark_person_cold] activity insert failed',
        { contactId: args.personId },
        activityErr,
      );
    }

    // The update mutation returns the post-patch row; reindex from it so the
    // 'cold' label is searchable (matches the old refresh-then-sync).
    if (refreshed) {
      syncContact(refreshed as Contact).catch((err) =>
        logger.warn('[tools.mark_person_cold] vector sync failed', { contactId: args.personId }, err),
      );
    }

    return {
      summary: `Marked ${contact.name || 'contact'} cold.`,
      data: { contactId: args.personId, leadScore: newScore },
      display: 'success',
    };
  },
});
