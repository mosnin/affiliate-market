import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * DemoProductProfile data access — Convex replacement for the Supabase reads/
 * writes in app/api/demos/products/route.ts, products/[id]/route.ts, and the
 * profile lookups in the booking (book/route.ts) and availability
 * (available/route.ts) + overrides validation flows.
 *
 * daysAvailable was a Postgres integer[]; it is a number[] here. No Postgres
 * uniqueness constraint on this table, so there's no read-then-insert invariant
 * to re-implement — straight inserts/patches.
 */

type ProfileFields = {
  id: string;
  spaceId: string;
  name: string;
  address?: string;
  demoDuration: number;
  startHour: number;
  endHour: number;
  daysAvailable: number[];
  bufferMinutes: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Legacy row shape: drop _id, surface `id`, coerce absent address -> null. */
function toRow(p: ProfileFields) {
  return {
    id: p.id,
    spaceId: p.spaceId,
    name: p.name,
    address: p.address ?? null,
    demoDuration: p.demoDuration,
    startHour: p.startHour,
    endHour: p.endHour,
    daysAvailable: p.daysAvailable,
    bufferMinutes: p.bufferMinutes,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** A profile by id, or null (PATCH/DELETE ownership resolve, booking +
 *  override validation lookups). The caller asserts spaceId / isActive. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('DemoProductProfile')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return doc ? toRow(doc) : null;
  },
});

/**
 * A space's profiles ordered by createdAt ascending, optionally only active.
 * Replaces the list GET (`.eq('spaceId').order('createdAt')`) and the
 * availability route's active-profiles read (`.eq('spaceId').eq('isActive', true)`).
 */
export const listBySpace = query({
  args: { spaceId: v.string(), activeOnly: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DemoProductProfile')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .order('asc')
      .collect();
    const filtered = args.activeOnly ? rows.filter((p) => p.isActive) : rows;
    return filtered.map(toRow);
  },
});

/**
 * Create a profile. Mirrors the POST defaults (demoDuration 30, startHour 9,
 * endHour 17, daysAvailable [1..5], bufferMinutes 0, isActive true). `address`
 * null clears the column. Returns the inserted row.
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    name: v.string(),
    address: v.union(v.string(), v.null()),
    demoDuration: v.optional(v.number()),
    startHour: v.optional(v.number()),
    endHour: v.optional(v.number()),
    daysAvailable: v.optional(v.array(v.number())),
    bufferMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      name: args.name,
      ...(args.address !== null ? { address: args.address } : {}),
      demoDuration: args.demoDuration ?? 30,
      startHour: args.startHour ?? 9,
      endHour: args.endHour ?? 17,
      daysAvailable: args.daysAvailable ?? [1, 2, 3, 4, 5],
      bufferMinutes: args.bufferMinutes ?? 0,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('DemoProductProfile', doc);
    return toRow(doc);
  },
});

/**
 * PATCH a profile, scoped to spaceId, bumping updatedAt. Applies only provided
 * fields. `address` null clears the column. Returns the updated row, or null if
 * the id/space doesn't match.
 */
export const updateById = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    name: v.optional(v.string()),
    address: v.optional(v.union(v.string(), v.null())),
    demoDuration: v.optional(v.number()),
    startHour: v.optional(v.number()),
    endHour: v.optional(v.number()),
    daysAvailable: v.optional(v.array(v.number())),
    bufferMinutes: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('DemoProductProfile')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc || doc.spaceId !== args.spaceId) return null;

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.address !== undefined) patch.address = args.address ?? undefined;
    if (args.demoDuration !== undefined) patch.demoDuration = args.demoDuration;
    if (args.startHour !== undefined) patch.startHour = args.startHour;
    if (args.endHour !== undefined) patch.endHour = args.endHour;
    if (args.daysAvailable !== undefined) patch.daysAvailable = args.daysAvailable;
    if (args.bufferMinutes !== undefined) patch.bufferMinutes = args.bufferMinutes;
    if (args.isActive !== undefined) patch.isActive = args.isActive;

    await ctx.db.patch(doc._id, patch);
    const updated = (await ctx.db.get(doc._id))!;
    return toRow(updated);
  },
});

/**
 * Delete a profile by id, scoped to spaceId. No-op if the id/space doesn't
 * match (the route resolved ownership first).
 */
export const deleteById = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const doc = await ctx.db
      .query('DemoProductProfile')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc || doc.spaceId !== args.spaceId) return;
    await ctx.db.delete(doc._id);
  },
});
