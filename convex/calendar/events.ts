import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * CalendarEvent data access — Convex replacement for the Supabase reads/writes
 * in lib/ai-tools/tools/{propose-demo-times,check-availability,block-time}.ts,
 * app/api/ai/realtime-session/route.ts, and app/api/mcp/route.ts.
 *
 * `date` is a 'YYYY-MM-DD' string and `time` is 'HH:MM' (or absent), exactly as
 * Postgres stored them, so the existing lexical range/order comparisons hold.
 */

/** Map a Convex doc to the legacy CalendarEvent row shape (drop _id/_creationTime,
 *  surface `id`, coerce absent optionals back to the SQL NULLs callers expect). */
function toRow(doc: {
  id: string;
  spaceId: string;
  title: string;
  description?: string;
  date: string;
  time?: string;
  color?: string;
  createdAt: string;
}) {
  return {
    id: doc.id,
    spaceId: doc.spaceId,
    title: doc.title,
    description: doc.description ?? null,
    date: doc.date,
    time: doc.time ?? null,
    color: doc.color ?? null,
    createdAt: doc.createdAt,
  };
}

/**
 * Events for a space within an inclusive [fromDate, toDate] date range.
 * Replaces the `.gte('date', from).lte('date', to)` reads (propose_demo_times,
 * check_availability). Ordered by date ascending.
 */
export const listByDateRange = query({
  args: {
    spaceId: v.string(),
    fromDate: v.string(),
    toDate: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CalendarEvent')
      .withIndex('by_space_date', (q) =>
        q.eq('spaceId', args.spaceId).gte('date', args.fromDate).lte('date', args.toDate),
      )
      .take(args.limit ?? 500);
    return rows.map(toRow);
  },
});

/**
 * Upcoming events for a space (date >= fromDate), ordered by date ascending.
 * Replaces the `.gte('date', today).order('date')` reads in realtime-session
 * and the MCP `list_calendar_events` tool.
 */
export const listUpcoming = query({
  args: {
    spaceId: v.string(),
    fromDate: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CalendarEvent')
      .withIndex('by_space_date', (q) =>
        q.eq('spaceId', args.spaceId).gte('date', args.fromDate),
      )
      .take(args.limit ?? 20);
    return rows.map(toRow);
  },
});

/**
 * Insert a calendar event (block_time). Returns the persisted row so the tool
 * can report exactly what landed. `color` defaults to 'gray' to match the old
 * column default; `description`/`time` are optional.
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    title: v.string(),
    date: v.string(),
    time: v.optional(v.string()),
    description: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      title: args.title,
      date: args.date,
      time: args.time,
      description: args.description,
      color: args.color ?? 'gray',
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('CalendarEvent', doc);
    return toRow(doc);
  },
});
