/**
 * `mark_person_hot` — promote a contact to the hot tier.
 *
 * Approval-gated: tier changes drive who appears in the morning story and
 * who triggers company-level new-lead notifications, so the seller wants
 * a checkpoint.
 *
 * Sets scoreLabel='hot' and bumps leadScore up to at least HOT_LEAD_THRESHOLD
 * (preserves a higher existing score). Inserts a status_change activity with
 * the reason. Re-syncs vector search so "hot" appears in semantic queries.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { syncContact } from '@/lib/vectorize';
import { logger } from '@/lib/logger';
import { HOT_LEAD_THRESHOLD } from '@/lib/constants';
import { defineTool } from '../types';
import type { Contact } from '@/lib/types';

const parameters = z
  .object({
    personId: z.string().min(1).describe('The Contact.id to mark hot.'),
    why: z
      .string()
      .min(1)
      .max(500)
      .describe('Why this person is hot — recorded on the timeline.'),
  })
  .describe('Mark a contact as a hot lead.');

interface MarkHotResult {
  contactId: string;
  leadScore: number;
}

export const markPersonHotTool = defineTool<typeof parameters, MarkHotResult>({
  name: 'mark_person_hot',
  riskLevel: 'low',
  description:
    "Mark a contact as a hot lead. Bumps lead score to at least the hot threshold and tags scoreLabel='hot'. Prompts for approval first.",
  parameters,
  requiresApproval: true,
  rateLimit: { max: 100, windowSeconds: 3600 },
  summariseCall(args) {
    return `Mark contact ${args.personId.slice(0, 8)} as hot`;
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

    const newScore = Math.max(contact.leadScore ?? 0, HOT_LEAD_THRESHOLD);

    let refreshed: Contact | null = null;
    try {
      refreshed = (await convex().mutation(api.contacts.contacts.update, {
        id: args.personId,
        spaceId: ctx.space.id,
        patch: {
          scoreLabel: 'hot',
          leadScore: newScore,
          scoringStatus: 'scored',
        },
        updatedAt: new Date().toISOString(),
      })) as Contact | null;
    } catch (updateErr) {
      logger.error(
        '[tools.mark_person_hot] update failed',
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
        content: `Marked hot: ${args.why}`,
        metadata: { scoreLabel: 'hot', leadScore: newScore, via: 'on_demand_agent' },
      });
    } catch (activityErr) {
      logger.warn(
        '[tools.mark_person_hot] activity insert failed',
        { contactId: args.personId },
        activityErr,
      );
    }

    // The update mutation returns the post-patch row; reindex from it so the
    // 'hot' label is searchable (matches the old refresh-then-sync).
    if (refreshed) {
      syncContact(refreshed as Contact).catch((err) =>
        logger.warn('[tools.mark_person_hot] vector sync failed', { contactId: args.personId }, err),
      );
    }

    return {
      summary: `Marked ${contact.name || 'contact'} hot.`,
      data: { contactId: args.personId, leadScore: newScore },
      display: 'success',
    };
  },
});
