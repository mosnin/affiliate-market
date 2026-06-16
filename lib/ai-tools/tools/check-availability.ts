/**
 * `check_availability` — does the seller have anything booked between two
 * ISO datetimes?
 *
 * Read-only. Looks at:
 *   • Demo rows (have native startsAt/endsAt)
 *   • CalendarEvent rows (have date + optional time text — best-effort
 *     conversion to a datetime band; events without a time are treated as
 *     all-day in that local-date sense)
 *
 * Returns `{ free, conflicts }`. Conflicts include title/start/end/kind.
 */

import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { defineTool } from '../types';

const parameters = z
  .object({
    from: z.string().datetime().describe('ISO start of the window.'),
    to: z.string().datetime().describe('ISO end of the window.'),
  })
  .refine((v) => new Date(v.to) > new Date(v.from), {
    message: '`to` must be after `from`.',
  })
  .describe('Check whether anything is booked in a time window.');

interface Conflict {
  title: string;
  startsAt: string;
  endsAt: string;
  kind: 'demo' | 'event';
}

interface CheckAvailabilityResult {
  free: boolean;
  conflicts: Conflict[];
}

/**
 * Combine CalendarEvent.date (YYYY-MM-DD) + optional time (HH:MM) into a
 * pair of ISO datetimes. Without a time, treat as the full local day.
 */
function eventBand(date: string, time: string | null): { startsAt: string; endsAt: string } {
  if (time && /^\d{2}:\d{2}$/.test(time)) {
    const startsAt = new Date(`${date}T${time}:00.000Z`).toISOString();
    // Default 60-min event when only a start is recorded.
    const endsAt = new Date(new Date(startsAt).getTime() + 60 * 60_000).toISOString();
    return { startsAt, endsAt };
  }
  const startsAt = new Date(`${date}T00:00:00.000Z`).toISOString();
  const endsAt = new Date(`${date}T23:59:59.000Z`).toISOString();
  return { startsAt, endsAt };
}

export const checkAvailabilityTool = defineTool<typeof parameters, CheckAvailabilityResult>({
  name: 'check_availability',
  riskLevel: 'safe',
  description:
    'Check whether the seller has Demos or CalendarEvents booked in a given ISO time window.',
  parameters,
  requiresApproval: false,

  async handler(args, ctx) {
    const fromIso = new Date(args.from).toISOString();
    const toIso = new Date(args.to).toISOString();
    const fromDate = fromIso.slice(0, 10);
    const toDate = toIso.slice(0, 10);

    // Both Demo and CalendarEvent are on Convex now. The overlap predicate is
    // `startsAt < to AND endsAt > from`; listBySpace bounds startsAt on the
    // index, so we filter `endsAt > from` in-process. Both throw on failure.
    let eventData: Array<{ id: string; title: string; date: string; time: string | null }>;
    let demoData: Array<{
      id: string;
      startsAt: string;
      endsAt: string;
      productAddress: string | null;
      guestName: string;
    }>;
    try {
      const [demoRows, events] = await Promise.all([
        convex().query(api.demos.demos.listBySpace, {
          spaceId: ctx.space.id,
          startsAtLt: toIso,
          order: 'asc',
        }),
        convex().query(api.calendar.events.listByDateRange, {
          spaceId: ctx.space.id,
          fromDate,
          toDate,
          limit: 50,
        }),
      ]);
      demoData = (demoRows as typeof demoData).filter((t) => t.endsAt > fromIso).slice(0, 20);
      eventData = events;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return { summary: `Availability check failed: ${message}`, display: 'error' };
    }

    const conflicts: Conflict[] = [];
    for (const t of demoData) {
      conflicts.push({
        title: t.productAddress
          ? `Demo: ${t.guestName} — ${t.productAddress}`
          : `Demo: ${t.guestName}`,
        startsAt: t.startsAt,
        endsAt: t.endsAt,
        kind: 'demo',
      });
    }
    for (const e of eventData) {
      const band = eventBand(e.date, e.time);
      // Filter all-day events down to the requested window.
      if (band.endsAt <= fromIso || band.startsAt >= toIso) continue;
      conflicts.push({ title: e.title, startsAt: band.startsAt, endsAt: band.endsAt, kind: 'event' });
    }

    conflicts.sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
    const free = conflicts.length === 0;
    return {
      summary: free
        ? 'You are free in that window.'
        : `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} in that window.`,
      data: { free, conflicts },
      display: 'plain',
    };
  },
});
