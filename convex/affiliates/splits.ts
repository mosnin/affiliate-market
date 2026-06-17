import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * CommissionSplit data access — the Convex replacement for the
 * `.from('CommissionSplit')` reads & writes in app/api/deals/[id]/commission-
 * splits/* and the seller commissions page.
 *
 * This is the REAL-ESTATE GCI split system (deal-scoped payout lines), separate
 * from the affiliate commission core. Money is numeric DOLLARS here (percentOfGci
 * a percent, flatAmount dollars) — NOT cents.
 *
 * The route owns all validation (party/basis/label/percent/flat ranges, the
 * basis<->field CHECK by clearing the other field when switching). These
 * functions do the DB hop, preserving the route's (id, dealId, spaceId) scoping
 * (the TOCTOU guard) on every read/update/delete. The Deal-ownership check stays
 * in the route (Deal is not this domain).
 */

const basisValidator = v.union(v.literal('percent'), v.literal('flat'));

type SplitFields = {
  id: string;
  dealId: string;
  spaceId: string;
  party: string;
  label: string;
  basis: 'percent' | 'flat';
  percentOfGci?: number;
  flatAmount?: number;
  paidAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

/** Full split row (the routes/page return `*`). Surface `id`, absent optionals
 *  -> null so the CommissionSplit shape the UI consumes is preserved. */
function toSplitRow(s: SplitFields) {
  return {
    id: s.id,
    dealId: s.dealId,
    spaceId: s.spaceId,
    party: s.party,
    label: s.label,
    basis: s.basis,
    percentOfGci: s.percentOfGci ?? null,
    flatAmount: s.flatAmount ?? null,
    paidAt: s.paidAt ?? null,
    notes: s.notes ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** A deal's splits (scoped to spaceId), earliest-first — the GET route.
 *  Mirrors `.eq('dealId').eq('spaceId').order('createdAt' asc)`. */
export const listForDeal = query({
  args: { dealId: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CommissionSplit')
      .withIndex('by_deal', (q) => q.eq('dealId', args.dealId))
      .collect();
    return rows
      .filter((s) => s.spaceId === args.spaceId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map(toSplitRow);
  },
});

/** All of a space's splits — the seller commissions page (folds by dealId in
 *  mem). idx_commission_split_space_paid. Mirrors `.eq('spaceId')`. */
export const listForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CommissionSplit')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.map(toSplitRow);
  },
});

/** One split scoped to (id, dealId, spaceId), or null — the PATCH/DELETE resolve
 *  guard. Mirrors `.eq('id').eq('dealId').eq('spaceId').maybeSingle()`. */
export const getScoped = query({
  args: { splitId: v.string(), dealId: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('CommissionSplit')
      .withIndex('by_app_id', (q) => q.eq('id', args.splitId))
      .unique();
    if (!s || s.dealId !== args.dealId || s.spaceId !== args.spaceId) return null;
    return toSplitRow(s);
  },
});

/**
 * Create a split (POST route). The route validated party/basis/label and which
 * of percentOfGci/flatAmount is set (the other is null). null -> absent column.
 * Returns the new row.
 */
export const create = mutation({
  args: {
    dealId: v.string(),
    spaceId: v.string(),
    party: v.string(),
    label: v.string(),
    basis: basisValidator,
    percentOfGci: v.union(v.number(), v.null()),
    flatAmount: v.union(v.number(), v.null()),
    paidAt: v.union(v.string(), v.null()),
    notes: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      dealId: args.dealId,
      spaceId: args.spaceId,
      party: args.party,
      label: args.label,
      basis: args.basis,
      ...(args.percentOfGci !== null ? { percentOfGci: args.percentOfGci } : {}),
      ...(args.flatAmount !== null ? { flatAmount: args.flatAmount } : {}),
      ...(args.paidAt !== null ? { paidAt: args.paidAt } : {}),
      ...(args.notes !== null ? { notes: args.notes } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('CommissionSplit', doc);
    return toSplitRow(doc);
  },
});

/**
 * Patch a split, scoped to (id, dealId, spaceId) (PATCH route). The route built
 * the field set (with the basis<->field CHECK already resolved). Each arg is a
 * union with null to model the route's "null clears" semantics; absent
 * (undefined) leaves the column unchanged. updatedAt is always stamped. Returns
 * the updated row, or null if the scoped row vanished (race).
 */
export const patchScoped = mutation({
  args: {
    splitId: v.string(),
    dealId: v.string(),
    spaceId: v.string(),
    party: v.optional(v.string()),
    label: v.optional(v.string()),
    basis: v.optional(basisValidator),
    percentOfGci: v.optional(v.union(v.number(), v.null())),
    flatAmount: v.optional(v.union(v.number(), v.null())),
    paidAt: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('CommissionSplit')
      .withIndex('by_app_id', (q) => q.eq('id', args.splitId))
      .unique();
    if (!s || s.dealId !== args.dealId || s.spaceId !== args.spaceId) return null;

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.party !== undefined) patch.party = args.party;
    if (args.label !== undefined) patch.label = args.label;
    if (args.basis !== undefined) patch.basis = args.basis;
    // null -> undefined clears the column (SQL NULL); the route already nulls the
    // off-basis field when switching basis, so both can arrive together.
    if (args.percentOfGci !== undefined)
      patch.percentOfGci = args.percentOfGci === null ? undefined : args.percentOfGci;
    if (args.flatAmount !== undefined)
      patch.flatAmount = args.flatAmount === null ? undefined : args.flatAmount;
    if (args.paidAt !== undefined) patch.paidAt = args.paidAt === null ? undefined : args.paidAt;
    if (args.notes !== undefined) patch.notes = args.notes === null ? undefined : args.notes;

    await ctx.db.patch(s._id, patch);
    const updated = (await ctx.db.get(s._id))!;
    return toSplitRow(updated);
  },
});

/** Delete a split scoped to (id, dealId, spaceId) (DELETE route). Returns true
 *  when a row was deleted. Mirrors `.delete().eq('id').eq('dealId').eq('spaceId')`. */
export const deleteScoped = mutation({
  args: { splitId: v.string(), dealId: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const s = await ctx.db
      .query('CommissionSplit')
      .withIndex('by_app_id', (q) => q.eq('id', args.splitId))
      .unique();
    if (!s || s.dealId !== args.dealId || s.spaceId !== args.spaceId) return false;
    await ctx.db.delete(s._id);
    return true;
  },
});

export type { SplitFields };
