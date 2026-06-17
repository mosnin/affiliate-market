/**
 * `find_overdue_followups` — contacts whose followUpAt has passed.
 *
 * Read-only. The follow-up date is a seller-set field; this is the simplest
 * signal of "you said you'd circle back, you haven't."
 */

import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { defineTool } from '../types';

const parameters = z
  .object({})
  .describe('Contacts whose followUpAt is in the past.');

interface OverdueFollowUp {
  id: string;
  name: string;
  followUpAt: string;
  daysOverdue: number;
}

interface FindOverdueResult {
  people: OverdueFollowUp[];
}

export const findOverdueFollowupsTool = defineTool<typeof parameters, FindOverdueResult>({
  name: 'find_overdue_followups',
  riskLevel: 'safe',
  description: 'Contacts where followUpAt is in the past. Up to 10, oldest first.',
  parameters,
  requiresApproval: false,

  async handler(_args, ctx) {
    const nowIso = new Date().toISOString();
    let data: Array<{ id: string; name: string; followUpAt: string | null }>;
    try {
      data = await convex().query(api.contacts.contacts.followUpsForSpaces, {
        spaceIds: [ctx.space.id],
        lte: nowIso,
        requireCompanyIdNull: true,
        limit: 10,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return { summary: `Overdue lookup failed: ${message}`, display: 'error' };
    }

    const rows = (data ?? []) as Array<{ id: string; name: string; followUpAt: string }>;
    if (rows.length === 0) {
      return {
        summary: 'No follow-ups overdue.',
        data: { people: [] },
        display: 'contacts',
      };
    }

    const now = Date.now();
    const people: OverdueFollowUp[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      followUpAt: r.followUpAt,
      daysOverdue: Math.max(0, Math.floor((now - new Date(r.followUpAt).getTime()) / 86_400_000)),
    }));

    return {
      summary: `${people.length} follow-up${people.length === 1 ? '' : 's'} overdue.`,
      data: { people },
      display: 'contacts',
    };
  },
});
