import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * DemoWaitlist data access — Convex replacement for the Supabase reads/writes
 * in app/api/demos/waitlist/route.ts, waitlist/notify/route.ts, and the
 * waitlist count in app/api/notifications/route.ts.
 *
 * Invariant carried from Postgres: at most one 'waiting' row per
 * (space, guestEmail, preferredDate) — the POST duplicate check, re-implemented
 * as a read-then-insert inside the single serializable `create` mutation.
 */

const statusValidator = v.union(
  v.literal('waiting'),
  v.literal('notified'),
  v.literal('booked'),
  v.literal('expired'),
);

type WaitlistFields = {
  id: string;
  spaceId: string;
  productProfileId?: string;
  guestName: string;
  guestEmail: string;
  guestPhone?: string;
  preferredDate: string;
  notes?: string;
  status: 'waiting' | 'notified' | 'booked' | 'expired';
  notifiedAt?: string;
  expiresAt?: string;
  createdAt: string;
};

/** Legacy row shape: drop _id, surface `id`, coerce absent optionals -> null
 *  (the waitlist `select('*')` reads expect these columns present). */
function toRow(w: WaitlistFields) {
  return {
    id: w.id,
    spaceId: w.spaceId,
    productProfileId: w.productProfileId ?? null,
    guestName: w.guestName,
    guestEmail: w.guestEmail,
    guestPhone: w.guestPhone ?? null,
    preferredDate: w.preferredDate,
    notes: w.notes ?? null,
    status: w.status,
    notifiedAt: w.notifiedAt ?? null,
    expiresAt: w.expiresAt ?? null,
    createdAt: w.createdAt,
  };
}

/**
 * A space's waitlist filtered to given statuses, ordered by preferredDate
 * ascending. Replaces the list GET's `.eq('spaceId').in('status',
 * ['waiting','notified']).order('preferredDate')`.
 */
export const listBySpace = query({
  args: { spaceId: v.string(), statuses: v.optional(v.array(statusValidator)) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DemoWaitlist')
      .withIndex('by_space_date', (q) => q.eq('spaceId', args.spaceId))
      .order('asc')
      .collect();
    const statusSet = args.statuses ? new Set(args.statuses) : null;
    const filtered = statusSet ? rows.filter((w) => statusSet.has(w.status)) : rows;
    return filtered.map(toRow);
  },
});

/**
 * Count a space's waitlist entries in a given status. Replaces the
 * notifications route's `.eq('spaceId').eq('status', 'waiting')` head count.
 */
export const countBySpaceStatus = query({
  args: { spaceId: v.string(), status: statusValidator },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DemoWaitlist')
      .withIndex('by_space_date', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.filter((w) => w.status === args.status).length;
  },
});

/**
 * A waitlist entry by id, scoped to space and required status, or null.
 * Replaces notify's `.eq('id').eq('spaceId').eq('status', 'waiting').maybeSingle()`.
 */
export const getByIdInSpace = query({
  args: { id: v.string(), spaceId: v.string(), status: v.optional(statusValidator) },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('DemoWaitlist')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc || doc.spaceId !== args.spaceId) return null;
    if (args.status !== undefined && doc.status !== args.status) return null;
    return toRow(doc);
  },
});

/**
 * Join the waitlist, enforcing one 'waiting' row per (space, email, date).
 * Returns the inserted row, or null if a duplicate already exists (the route
 * maps null -> 409). `productProfileId`/`guestPhone`/`notes` null clear their
 * columns. status defaults to 'waiting'.
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    productProfileId: v.union(v.string(), v.null()),
    guestName: v.string(),
    guestEmail: v.string(),
    guestPhone: v.union(v.string(), v.null()),
    preferredDate: v.string(),
    notes: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DemoWaitlist')
      .withIndex('by_space_date', (q) =>
        q.eq('spaceId', args.spaceId).eq('preferredDate', args.preferredDate),
      )
      .collect();
    const dup = rows.some((w) => w.status === 'waiting' && w.guestEmail === args.guestEmail);
    if (dup) return null; // caller returns 409 (already on waitlist)

    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      ...(args.productProfileId !== null ? { productProfileId: args.productProfileId } : {}),
      guestName: args.guestName,
      guestEmail: args.guestEmail,
      ...(args.guestPhone !== null ? { guestPhone: args.guestPhone } : {}),
      preferredDate: args.preferredDate,
      ...(args.notes !== null ? { notes: args.notes } : {}),
      status: 'waiting' as const,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('DemoWaitlist', doc);
    return toRow(doc);
  },
});

/**
 * Mark a waitlisted guest as notified with a hold window (status -> 'notified',
 * notifiedAt, expiresAt), scoped to space. Returns the updated row, or null if
 * the id/space doesn't match. Replaces notify's `.update({...}).eq('id')` after
 * its own status check.
 */
export const markNotified = mutation({
  args: { id: v.string(), spaceId: v.string(), notifiedAt: v.string(), expiresAt: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('DemoWaitlist')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc || doc.spaceId !== args.spaceId) return null;
    await ctx.db.patch(doc._id, {
      status: 'notified',
      notifiedAt: args.notifiedAt,
      expiresAt: args.expiresAt,
    });
    return toRow({
      ...doc,
      status: 'notified',
      notifiedAt: args.notifiedAt,
      expiresAt: args.expiresAt,
    });
  },
});
