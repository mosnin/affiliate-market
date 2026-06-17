/**
 * `find_quiet_hot_persons` — hot leads with no recent contact.
 *
 * Read-only. "Hot" = scoreLabel='hot'. Quiet = no ContactActivity newer
 * than minDaysQuiet days. We resolve activity-recency with a single
 * grouped query rather than per-row N+1.
 */

import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { defineTool } from '../types';

const parameters = z
  .object({
    minDaysQuiet: z.number().int().min(1).max(180).optional().default(7),
  })
  .describe('Hot contacts with no activity newer than minDaysQuiet.');

interface QuietHotPerson {
  id: string;
  name: string;
  leadScore: number | null;
  daysSinceLastTouch: number | null;
}

interface FindQuietHotPersonsResult {
  people: QuietHotPerson[];
}

export const findQuietHotPersonsTool = defineTool<
  typeof parameters,
  FindQuietHotPersonsResult
>({
  name: 'find_quiet_hot_persons',
  riskLevel: 'safe',
  description: 'Find hot-scored contacts who haven\'t been contacted in minDaysQuiet days (default 7).',
  parameters,
  requiresApproval: false,

  async handler(args, ctx) {
    const minDays = args.minDaysQuiet ?? 7;
    const now = Date.now();
    const cutoff = new Date(now - minDays * 86_400_000).toISOString();

    let data: Array<{
      id: string;
      name: string;
      leadScore: number | null;
      lastContactedAt: string | null;
      updatedAt: string;
    }>;
    try {
      data = await convex().query(api.contacts.contacts.topByScoreForSpace, {
        spaceId: ctx.space.id,
        scoreLabel: 'hot',
        requireCompanyIdNull: true,
        limit: 40,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return { summary: `Quiet-hot lookup failed: ${message}`, display: 'error' };
    }

    const rows = (data ?? []) as Array<{
      id: string;
      name: string;
      leadScore: number | null;
      lastContactedAt: string | null;
      updatedAt: string;
    }>;
    if (rows.length === 0) {
      return {
        summary: 'No hot contacts in this workspace.',
        data: { people: [] },
        display: 'contacts',
      };
    }

    // For contacts with no lastContactedAt we still want a "quiet for X days"
    // signal — fall back to the most-recent ContactActivity per contact.
    const ids = rows.map((r) => r.id);
    let activities: Array<{ contactId: string; createdAt: string }> = [];
    try {
      activities = await convex().query(api.contacts.activity.listForContacts, {
        contactIds: ids,
        spaceId: ctx.space.id,
      });
    } catch {
      activities = [];
    }
    const lastActMap = new Map<string, string>();
    for (const a of activities as Array<{ contactId: string; createdAt: string }>) {
      if (!lastActMap.has(a.contactId)) lastActMap.set(a.contactId, a.createdAt);
    }

    const people: QuietHotPerson[] = rows
      .map((r) => {
        const anchor = r.lastContactedAt ?? lastActMap.get(r.id) ?? null;
        const daysSinceLastTouch =
          anchor == null
            ? null
            : Math.floor((now - new Date(anchor).getTime()) / 86_400_000);
        return {
          id: r.id,
          name: r.name,
          leadScore: r.leadScore,
          daysSinceLastTouch,
          _anchor: anchor,
        };
      })
      .filter((p) => p.daysSinceLastTouch == null || p.daysSinceLastTouch >= minDays)
      .sort(
        (a, b) =>
          (b.daysSinceLastTouch ?? Number.MAX_SAFE_INTEGER) -
          (a.daysSinceLastTouch ?? Number.MAX_SAFE_INTEGER),
      )
      .slice(0, 10)
      .map(({ _anchor: _drop, ...p }) => p);

    return {
      summary:
        people.length === 0
          ? `No hot contacts have gone quiet for ${minDays}+ days.`
          : `${people.length} hot contact${people.length === 1 ? '' : 's'} quiet for ${minDays}+ days.`,
      data: { people },
      display: 'contacts',
    };
  },
});
