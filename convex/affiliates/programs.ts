import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * AffiliateProgram data access — the Convex replacement for the
 * `.from('AffiliateProgram')` reads & writes in lib/affiliates/programs.ts
 * (and the program reads in conversions/recurring/tier2/explore/payouts).
 *
 * Pure logic (holdDaysFor, matureAtFor, the ProgramPatch clamping) stays in
 * lib/affiliates/programs.ts — only the DB hops move here.
 *
 * Invariant preserved: one default program per space. getOrCreate reads the
 * earliest program for the space (by_space) and inserts only if none exists,
 * inside one serializable mutation — the old code's select-then-insert-then-
 * select-on-race collapses to a single atomic read-then-insert.
 */

const commissionTypeValidator = v.union(v.literal('percent'), v.literal('flat'));

/** App columns of an AffiliateProgram — the AffiliateProgramRow shape lib uses.
 *  A stored Doc and a fresh insert payload both satisfy this. */
type ProgramFields = {
  id: string;
  spaceId: string;
  name: string;
  commissionType: 'percent' | 'flat';
  commissionValue: number;
  recurring: boolean;
  recurringMonths?: number;
  cookieWindowDays: number;
  autoApproveAffiliates: boolean;
  autoApproveCommissions: boolean;
  createdAt: string;
  updatedAt: string;
  tier2Enabled: boolean;
  tier2Percent: number;
  holdDays: number;
  minPayoutCents: number;
};

/** AffiliateProgramRow shape (lib/affiliates/programs.ts#AffiliateProgramRow).
 *  Surface `id`, coerce absent recurringMonths -> null (SQL NULL). */
function toProgramRow(p: ProgramFields) {
  return {
    id: p.id,
    spaceId: p.spaceId,
    name: p.name,
    commissionType: p.commissionType,
    commissionValue: p.commissionValue,
    recurring: p.recurring,
    recurringMonths: p.recurringMonths ?? null,
    cookieWindowDays: p.cookieWindowDays,
    autoApproveAffiliates: p.autoApproveAffiliates,
    autoApproveCommissions: p.autoApproveCommissions,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    tier2Enabled: p.tier2Enabled,
    tier2Percent: p.tier2Percent,
    holdDays: p.holdDays,
    minPayoutCents: p.minPayoutCents,
  };
}

/** PG column defaults for AffiliateProgram (the insert omitted them). */
const PROGRAM_DEFAULTS = {
  name: 'Default program',
  commissionType: 'percent' as const,
  commissionValue: 20,
  recurring: false,
  cookieWindowDays: 30,
  autoApproveAffiliates: false,
  autoApproveCommissions: false,
  tier2Enabled: false,
  tier2Percent: 10,
  holdDays: 14,
  minPayoutCents: 2000,
};

/** One program by id, or null. Mirrors `.from('AffiliateProgram').eq('id').maybeSingle()`
 *  (loadProgram in recurring, the program read in conversions/tier2). */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AffiliateProgram')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return p ? toProgramRow(p) : null;
  },
});

/** The earliest program for a space, or null (read-only — does NOT create).
 *  Mirrors `.eq('spaceId').order('createdAt' asc).limit(1).maybeSingle()`. */
export const getForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliateProgram')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    if (rows.length === 0) return null;
    rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return toProgramRow(rows[0]);
  },
});

/** Program terms for many spaces (explore). Returns the earliest program per
 *  space. Mirrors `.in('spaceId', ids).order('createdAt' asc)` folded to first-per-space. */
export const termsForSpaces = query({
  args: { spaceIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Array<{
      spaceId: string;
      commissionType: 'percent' | 'flat';
      commissionValue: number;
      recurring: boolean;
      createdAt: string;
    }> = [];
    const seen = new Set<string>();
    for (const spaceId of args.spaceIds) {
      if (seen.has(spaceId)) continue;
      seen.add(spaceId);
      const rows = await ctx.db
        .query('AffiliateProgram')
        .withIndex('by_space', (q) => q.eq('spaceId', spaceId))
        .collect();
      if (rows.length === 0) continue;
      rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      const p = rows[0];
      out.push({
        spaceId: p.spaceId,
        commissionType: p.commissionType,
        commissionValue: p.commissionValue,
        recurring: p.recurring,
        createdAt: p.createdAt,
      });
    }
    return out;
  },
});

/**
 * Every space gets one program, created lazily on first touch. Replaces
 * getOrCreateDefaultProgram. Read-then-insert in ONE mutation makes the
 * one-program-per-space invariant race-free (no create-race retry needed).
 */
export const getOrCreateDefault = mutation({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliateProgram')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    if (rows.length > 0) {
      rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      return toProgramRow(rows[0]);
    }
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      ...PROGRAM_DEFAULTS,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('AffiliateProgram', doc);
    return toProgramRow(doc);
  },
});

/**
 * Patch the space's default program. Replaces updateProgram's DB hop. The lib
 * still does the clamping (commissionValue >= 0, cookieWindowDays 1-365,
 * tier2Percent 0-50, recurringMonths null/1-120) and passes the final values;
 * this mutation getOrCreates then patches, stamping updatedAt. `recurringMonths`
 * accepts null to clear (lifetime). Returns the updated row, or null if absent.
 */
export const update = mutation({
  args: {
    spaceId: v.string(),
    name: v.optional(v.string()),
    commissionType: v.optional(commissionTypeValidator),
    commissionValue: v.optional(v.number()),
    cookieWindowDays: v.optional(v.number()),
    autoApproveAffiliates: v.optional(v.boolean()),
    autoApproveCommissions: v.optional(v.boolean()),
    tier2Enabled: v.optional(v.boolean()),
    tier2Percent: v.optional(v.number()),
    recurring: v.optional(v.boolean()),
    recurringMonths: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    // getOrCreate inline (same as lib calling getOrCreateDefaultProgram first).
    const existing = await ctx.db
      .query('AffiliateProgram')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    let row: Doc<'AffiliateProgram'>;
    if (existing.length > 0) {
      existing.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      row = existing[0];
    } else {
      const now = new Date().toISOString();
      const id = await ctx.db.insert('AffiliateProgram', {
        id: crypto.randomUUID(),
        spaceId: args.spaceId,
        ...PROGRAM_DEFAULTS,
        createdAt: now,
        updatedAt: now,
      });
      row = (await ctx.db.get(id))!;
    }

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.commissionType !== undefined) patch.commissionType = args.commissionType;
    if (args.commissionValue !== undefined) patch.commissionValue = args.commissionValue;
    if (args.cookieWindowDays !== undefined) patch.cookieWindowDays = args.cookieWindowDays;
    if (args.autoApproveAffiliates !== undefined)
      patch.autoApproveAffiliates = args.autoApproveAffiliates;
    if (args.autoApproveCommissions !== undefined)
      patch.autoApproveCommissions = args.autoApproveCommissions;
    if (args.tier2Enabled !== undefined) patch.tier2Enabled = args.tier2Enabled;
    if (args.tier2Percent !== undefined) patch.tier2Percent = args.tier2Percent;
    if (args.recurring !== undefined) patch.recurring = args.recurring;
    if (args.recurringMonths !== undefined) {
      // null clears (lifetime); absent column in Convex == SQL NULL.
      if (args.recurringMonths === null) patch.recurringMonths = undefined;
      else patch.recurringMonths = args.recurringMonths;
    }
    await ctx.db.patch(row._id, patch);
    const updated = (await ctx.db.get(row._id))!;
    return toProgramRow(updated);
  },
});

/** minPayoutCents for a program (the payout floor check), or null if absent.
 *  Mirrors `.from('AffiliateProgram').select('minPayoutCents').eq('id')`. */
export const minPayoutCentsForProgram = query({
  args: { programId: v.string() },
  handler: async (ctx, args): Promise<number | null> => {
    const p = await ctx.db
      .query('AffiliateProgram')
      .withIndex('by_app_id', (q) => q.eq('id', args.programId))
      .unique();
    return p ? p.minPayoutCents : null;
  },
});

/** tier-2 settings for a program (tier2Enabled, tier2Percent, holdDays), or null.
 *  Mirrors the `.select('tier2Enabled, tier2Percent, holdDays').eq('id')` in tier2.ts. */
export const tier2SettingsForProgram = query({
  args: { programId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AffiliateProgram')
      .withIndex('by_app_id', (q) => q.eq('id', args.programId))
      .unique();
    if (!p) return null;
    return { tier2Enabled: p.tier2Enabled, tier2Percent: p.tier2Percent, holdDays: p.holdDays };
  },
});

// Exported for sibling modules' types (none needed at runtime).
export type { ProgramFields };
