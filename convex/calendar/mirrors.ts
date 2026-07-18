import { mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * CalendarEventMirror data access — Convex replacement for the two insert sites
 * (lib/calendar/mirror.ts writeEventThrough, app/api/cola/post-demo/execute
 * logCalendarMirrorBestEffort). Insert-only: the mirror is a forensic backup of
 * what Cola wrote to the seller's external calendar. Nothing reads it today.
 */

const createdByValidator = v.union(v.literal('agent'), v.literal('seller'));

/**
 * Log a mirror row. Returns the new row id (the only field both callers use).
 * `externalEventId`/`sourceDemoId` are optional (absent ⇔ SQL NULL); `attendees`
 * defaults to [] to match the old jsonb default; `createdBy` defaults to 'agent'.
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    externalProvider: v.string(),
    externalEventId: v.optional(v.string()),
    title: v.string(),
    start: v.string(),
    end: v.string(),
    attendees: v.optional(v.any()),
    sourceDemoId: v.optional(v.string()),
    createdBy: v.optional(createdByValidator),
  },
  handler: async (ctx, args): Promise<{ id: string }> => {
    const id = crypto.randomUUID();
    await ctx.db.insert('CalendarEventMirror', {
      id,
      spaceId: args.spaceId,
      externalProvider: args.externalProvider,
      externalEventId: args.externalEventId,
      title: args.title,
      start: args.start,
      end: args.end,
      attendees: args.attendees ?? [],
      sourceDemoId: args.sourceDemoId,
      createdBy: args.createdBy ?? 'agent',
      createdAt: new Date().toISOString(),
    });
    return { id };
  },
});
