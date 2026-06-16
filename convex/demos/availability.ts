import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * DemoAvailabilityOverride data access — Convex replacement for the Supabase
 * reads/writes in app/api/demos/overrides/route.ts, overrides/[id]/route.ts,
 * and the availability calculator (app/api/demos/available/route.ts).
 *
 * Invariant carried from Postgres: one override per (space, date) — PG had a
 * UNIQUE on (spaceId, date), but the app keys on the product profile too and
 * handles the NULL-product case by hand. The POST's "find existing on
 * (space, date[, product]) and delete it, then insert" becomes the single
 * serializable `upsert` mutation below.
 */

const recurrenceValidator = v.union(
  v.literal('none'),
  v.literal('weekly'),
  v.literal('biweekly'),
  v.literal('monthly'),
);

type OverrideFields = {
  id: string;
  spaceId: string;
  productProfileId?: string;
  date: string;
  isBlocked: boolean;
  startHour?: number;
  endHour?: number;
  label?: string;
  recurrence: 'none' | 'weekly' | 'biweekly' | 'monthly';
  endDate?: string;
  createdAt: string;
};

/** Legacy row shape: drop _id, surface `id`, coerce absent optionals -> null
 *  (the override `select('*')` reads expect these columns present). */
function toRow(o: OverrideFields) {
  return {
    id: o.id,
    spaceId: o.spaceId,
    productProfileId: o.productProfileId ?? null,
    date: o.date,
    isBlocked: o.isBlocked,
    startHour: o.startHour ?? null,
    endHour: o.endHour ?? null,
    label: o.label ?? null,
    recurrence: o.recurrence,
    endDate: o.endDate ?? null,
    createdAt: o.createdAt,
  };
}

/**
 * All overrides for a space, ordered by date ascending. Replaces the
 * `.from('DemoAvailabilityOverride').select('*').eq('spaceId',...).order('date')`
 * reads. The list route and the availability calculator do their own product /
 * recurrence / past-date filtering in JS, so this stays a plain space read.
 */
export const listBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DemoAvailabilityOverride')
      .withIndex('by_space_date', (q) => q.eq('spaceId', args.spaceId))
      .order('asc')
      .collect();
    return rows.map(toRow);
  },
});

/** An override's owning spaceId by id (the DELETE route's ownership check),
 *  or null. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('DemoAvailabilityOverride')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return doc ? toRow(doc) : null;
  },
});

/**
 * Upsert an override for (space, date, productProfile): delete any existing
 * row(s) on that key, then insert the new one. Re-implements the POST's
 * delete-then-insert as one serializable mutation, preserving the NULL-product
 * distinction (a global override and a product-scoped one on the same date
 * coexist; only a same-product match is replaced). Returns the inserted row.
 *
 * `startHour`/`endHour`/`endDate` are nullable: null clears the column.
 */
export const upsert = mutation({
  args: {
    spaceId: v.string(),
    productProfileId: v.union(v.string(), v.null()),
    date: v.string(),
    isBlocked: v.boolean(),
    startHour: v.union(v.number(), v.null()),
    endHour: v.union(v.number(), v.null()),
    label: v.union(v.string(), v.null()),
    recurrence: recurrenceValidator,
    endDate: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    // Find existing rows on (space, date) then narrow to the same product key
    // (null-vs-null or matching id), matching the route's productProfileId
    // .eq / .is('null') branch.
    const sameDate = await ctx.db
      .query('DemoAvailabilityOverride')
      .withIndex('by_space_date', (q) => q.eq('spaceId', args.spaceId).eq('date', args.date))
      .collect();
    for (const ex of sameDate) {
      const exProduct = ex.productProfileId ?? null;
      if (exProduct === args.productProfileId) {
        await ctx.db.delete(ex._id);
      }
    }

    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      ...(args.productProfileId !== null ? { productProfileId: args.productProfileId } : {}),
      date: args.date,
      isBlocked: args.isBlocked,
      ...(args.startHour !== null ? { startHour: args.startHour } : {}),
      ...(args.endHour !== null ? { endHour: args.endHour } : {}),
      ...(args.label !== null ? { label: args.label } : {}),
      recurrence: args.recurrence,
      ...(args.endDate !== null ? { endDate: args.endDate } : {}),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('DemoAvailabilityOverride', doc);
    return toRow(doc);
  },
});

/**
 * Delete an override by id, scoped to spaceId (matches the route's
 * `.delete().eq('id').eq('spaceId')` after its own ownership check). No-op if
 * the row/space doesn't match.
 */
export const deleteById = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const doc = await ctx.db
      .query('DemoAvailabilityOverride')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc || doc.spaceId !== args.spaceId) return;
    await ctx.db.delete(doc._id);
  },
});
