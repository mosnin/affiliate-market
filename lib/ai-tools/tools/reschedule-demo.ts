/**
 * `reschedule_demo` — move a Demo to a new start (and optional end) time.
 *
 * Approval-gated: demos are on calendars and inboxes; the seller sees
 * the new time before we commit. Google Calendar sync runs server-side
 * on a separate cron job (see schedule-demo.ts), so we don't duplicate
 * it here — same stance as the create path.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';

const parameters = z
  .object({
    demoId: z.string().min(1).describe('The Demo.id to reschedule.'),
    newStartsAt: z.string().datetime().describe('New ISO start time.'),
    newEndsAt: z
      .string()
      .datetime()
      .optional()
      .describe('Optional new ISO end. Defaults to preserving the original duration.'),
    why: z.string().max(500).optional(),
  })
  .describe('Move a demo to a new time.');

interface RescheduleDemoResult {
  demoId: string;
  startsAt: string;
  endsAt: string;
}

function pretty(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export const rescheduleDemoTool = defineTool<typeof parameters, RescheduleDemoResult>({
  name: 'reschedule_demo',
  riskLevel: 'low',
  description:
    'Move a demo to a new time. Preserves the original duration unless newEndsAt is given. Prompts for approval first.',
  parameters,
  requiresApproval: true,
  rateLimit: { max: 60, windowSeconds: 3600 },
  summariseCall(args) {
    const why = args.why ? ` — ${args.why}` : '';
    return `Reschedule demo ${args.demoId.slice(0, 8)} → ${pretty(args.newStartsAt)}${why}`;
  },

  async handler(args, ctx) {
    let demo: {
      id: string;
      startsAt: string;
      endsAt: string;
      contactId: string | null;
      productAddress: string | null;
      guestName: string;
      status: string;
    } | null;
    try {
      demo = await convex().query(api.demos.demos.getByIdInSpace, {
        id: args.demoId,
        spaceId: ctx.space.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return { summary: `Demo lookup failed: ${message}`, display: 'error' };
    }
    if (!demo) {
      return { summary: `No demo with that id.`, display: 'error' };
    }
    if (demo.status === 'cancelled') {
      return { summary: `That demo is already cancelled — schedule a new one instead.`, display: 'error' };
    }

    const newStarts = new Date(args.newStartsAt);
    let newEnds: Date;
    if (args.newEndsAt) {
      newEnds = new Date(args.newEndsAt);
      if (newEnds <= newStarts) {
        return { summary: `End time must be after start time.`, display: 'error' };
      }
    } else {
      // Preserve original duration.
      const oldStart = new Date(demo.startsAt as string).getTime();
      const oldEnd = new Date(demo.endsAt as string).getTime();
      const duration = Math.max(15 * 60 * 1000, oldEnd - oldStart);
      newEnds = new Date(newStarts.getTime() + duration);
    }

    try {
      await convex().mutation(api.demos.demos.updateTimes, {
        id: args.demoId,
        spaceId: ctx.space.id,
        startsAt: newStarts.toISOString(),
        endsAt: newEnds.toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.error('[tools.reschedule_demo] update failed', { demoId: args.demoId }, err);
      return { summary: `Reschedule failed: ${message}`, display: 'error' };
    }

    if (demo.contactId) {
      const { error: activityErr } = await supabase.from('ContactActivity').insert({
        id: crypto.randomUUID(),
        spaceId: ctx.space.id,
        contactId: demo.contactId,
        type: 'meeting',
        content: `Demo rescheduled to ${args.newStartsAt}${args.why ? `: ${args.why}` : ''}`,
        metadata: { demoId: args.demoId, oldStartsAt: demo.startsAt, newStartsAt: newStarts.toISOString(), via: 'on_demand_agent' },
      });
      if (activityErr) {
        logger.warn('[tools.reschedule_demo] activity insert failed', { demoId: args.demoId }, activityErr);
      }
    }

    const guest = (demo.guestName as string | null) || 'guest';
    return {
      summary: `Demo for ${guest} rescheduled to ${pretty(newStarts.toISOString())}.`,
      data: { demoId: args.demoId, startsAt: newStarts.toISOString(), endsAt: newEnds.toISOString() },
      display: 'success',
    };
  },
});
