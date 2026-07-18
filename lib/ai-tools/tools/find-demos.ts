/**
 * `find_demos` — read-only lookup over the Demo table.
 *
 * Four filters cover 95% of the seller's questions:
 *   - "what demos does Jane have on the books?"   → personId
 *   - "what demos are scheduled for that listing?" → productId
 *   - "what's on the calendar this week?"          → fromDate/toDate
 *   - "any cancelled demos I should know about?"   → status
 *
 * Anything beyond that is gold-plating; cut.
 */

import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { defineTool } from '../types';

const parameters = z
  .object({
    personId: z.string().min(1).optional().describe('Contact.id to filter by.'),
    productId: z.string().min(1).optional().describe('Product.id to filter by.'),
    fromDate: z.string().datetime().optional().describe('ISO start of the window (inclusive).'),
    toDate: z.string().datetime().optional().describe('ISO end of the window (inclusive).'),
    status: z
      .enum(['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'])
      .optional()
      .describe('Limit to a single status.'),
  })
  .describe('Find demos by person, product, date window, or status.');

interface DemoRow {
  id: string;
  startsAt: string;
  endsAt: string;
  productAddress: string | null;
  guestName: string;
  status: string;
}

interface FindDemosResult {
  demos: DemoRow[];
}

export const findDemosTool = defineTool<typeof parameters, FindDemosResult>({
  name: 'find_demos',
  riskLevel: 'safe',
  description:
    "List demos filtered by person, product, date range, or status. Up to 20, sorted by start time.",
  parameters,
  requiresApproval: false,

  async handler(args, ctx) {
    let demos: DemoRow[];
    try {
      // Fetch the space's demos with the filters listBySpace supports natively
      // (status / startsAt range / product), ordered by startsAt. personId
      // (contactId) isn't an index field here, so narrow it in-process and
      // apply the 20-row cap last so the contact filter can't be truncated.
      const rows = (await convex().query(api.demos.demos.listBySpace, {
        spaceId: ctx.space.id,
        order: 'asc',
        // Only cap at the query when there's no in-process contact filter to
        // apply afterward — otherwise the cap could truncate matches.
        ...(args.personId ? {} : { limit: 20 }),
        ...(args.status ? { statuses: [args.status] } : {}),
        ...(args.fromDate ? { startsAtGte: args.fromDate } : {}),
        ...(args.toDate ? { startsAtLte: args.toDate } : {}),
        ...(args.productId ? { productId: args.productId } : {}),
      })) as Array<DemoRow & { contactId: string | null }>;
      const matched = args.personId
        ? rows.filter((d) => d.contactId === args.personId)
        : rows;
      demos = matched.slice(0, 20);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return { summary: `Demo lookup failed: ${message}`, display: 'error' };
    }

    if (demos.length === 0) {
      return {
        summary: 'No demos matched.',
        data: { demos: [] },
        display: 'demos',
      };
    }

    const lines = demos.slice(0, 5).map((t) => {
      const when = new Date(t.startsAt).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      const where = t.productAddress ? ` at ${t.productAddress}` : '';
      return `• ${when} — ${t.guestName}${where} (${t.status})`;
    });
    const more = demos.length > 5 ? `\n…and ${demos.length - 5} more.` : '';

    return {
      summary: `${demos.length} demo${demos.length === 1 ? '' : 's'}:\n${lines.join('\n')}${more}`,
      data: { demos },
      display: 'demos',
    };
  },
});
