import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * AffiliatePayout data access — the Convex replacement for the
 * `.from('AffiliatePayout')` reads & writes in payouts.ts + tax-export +
 * finance.
 *
 * MONEY: amountCents = creator NET (what actually transfers via Connect).
 * platformFeeCents = Cola's accrued cut over the consumed commissions. The lib
 * computed both (netTotal = approvedNet + balance adjustment; feeTotal) and the
 * period dates; we STORE them — never recomputed here.
 *
 * CROSS-DOMAIN STAYS IN LIB: createPayout also marks commissions paid
 * (commissions.markPaid), zeroes the partner clawback (partners
 * .setBalanceAdjustment), and fires the Stripe transfer + email. Those stay lib
 * calls. This module owns only the AffiliatePayout row: create returns the row,
 * the lib then does the cross-table writes and (on transfer success) calls
 * complete to flip it.
 */

const payoutStatusValidator = v.union(
  v.literal('pending'),
  v.literal('processing'),
  v.literal('completed'),
  v.literal('failed'),
);

type PayoutFields = {
  id: string;
  spaceId: string;
  partnerId: string;
  amountCents: number;
  method?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  periodStart?: string;
  periodEnd?: string;
  paidAt?: string;
  createdAt: string;
  platformFeeCents: number;
  stripeTransferId?: string;
};

/** AffiliatePayoutRow shape (lib/affiliates/payouts.ts#AffiliatePayoutRow).
 *  Surface `id`, coerce absent optionals -> null. */
function toPayoutRow(p: PayoutFields) {
  return {
    id: p.id,
    spaceId: p.spaceId,
    partnerId: p.partnerId,
    amountCents: p.amountCents, // creator NET
    platformFeeCents: p.platformFeeCents,
    method: p.method ?? null,
    status: p.status,
    stripeTransferId: p.stripeTransferId ?? null,
    periodStart: p.periodStart ?? null,
    periodEnd: p.periodEnd ?? null,
    paidAt: p.paidAt ?? null,
    createdAt: p.createdAt,
  };
}

/**
 * Insert a pending payout (createPayout's DB hop). The lib computed amountCents
 * (creator NET), platformFeeCents, method (stripe when the partner has a Connect
 * account, else their payoutMethod), and the period window. status starts
 * 'pending'. Returns the row so the lib can mark commissions paid + attempt the
 * transfer.
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    partnerId: v.string(),
    amountCents: v.number(), // creator NET
    platformFeeCents: v.number(),
    method: v.union(v.string(), v.null()),
    periodStart: v.union(v.string(), v.null()),
    periodEnd: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      partnerId: args.partnerId,
      amountCents: args.amountCents,
      platformFeeCents: args.platformFeeCents,
      ...(args.method !== null ? { method: args.method } : {}),
      status: 'pending' as const,
      ...(args.periodStart !== null ? { periodStart: args.periodStart } : {}),
      ...(args.periodEnd !== null ? { periodEnd: args.periodEnd } : {}),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('AffiliatePayout', doc);
    return toPayoutRow(doc);
  },
});

/**
 * Mark a payout completed. Optional stripeTransferId (set when a Connect transfer
 * just succeeded). Stamps paidAt. Returns the updated row (createPayout's
 * Stripe-success branch) — or the (partnerId, amountCents, method) the
 * markPayoutCompleted email needs. Mirrors both
 * `.update({status:'completed',stripeTransferId,paidAt}).eq('id')` and
 * `.update({status:'completed',paidAt}).eq('id')`.
 */
export const complete = mutation({
  args: { payoutId: v.string(), stripeTransferId: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AffiliatePayout')
      .withIndex('by_app_id', (q) => q.eq('id', args.payoutId))
      .unique();
    if (!p) return null;
    await ctx.db.patch(p._id, {
      status: 'completed',
      paidAt: new Date().toISOString(),
      ...(args.stripeTransferId !== null ? { stripeTransferId: args.stripeTransferId } : {}),
    });
    const updated = (await ctx.db.get(p._id))!;
    return toPayoutRow(updated);
  },
});

/** Mark a payout failed. Mirrors `.update({status:'failed'}).eq('id')`. */
export const fail = mutation({
  args: { payoutId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const p = await ctx.db
      .query('AffiliatePayout')
      .withIndex('by_app_id', (q) => q.eq('id', args.payoutId))
      .unique();
    if (!p) return false;
    await ctx.db.patch(p._id, { status: 'failed' });
    return true;
  },
});

/** Raw payout rows for a space, newest-first (cap 100) — listPayouts' base read
 *  (the lib joins partner name/email). idx_affiliate_payout_space. */
export const listForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliatePayout')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .take(100);
    return rows.map(toPayoutRow);
  },
});

/** Payout history across a creator's partner ids, newest-first (cap 100) —
 *  listPayoutsForPartners. idx_affiliate_payout_partner. */
export const listForPartners = query({
  args: { partnerIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const all: PayoutFields[] = [];
    for (const partnerId of args.partnerIds) {
      const rows = await ctx.db
        .query('AffiliatePayout')
        .withIndex('by_partner_created', (q) => q.eq('partnerId', partnerId))
        .collect();
      all.push(...rows);
    }
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return all.slice(0, 100).map(toPayoutRow);
  },
});

/** Completed payouts in a paidAt window across all partners — tax-export's read
 *  (per-partner NET paid totals). Returns (partnerId, amountCents). Mirrors
 *  `.eq('status','completed').gte('paidAt', from).lt('paidAt', to)`. */
export const completedInWindow = query({
  args: { from: v.string(), to: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliatePayout')
      .withIndex('by_status_paid', (q) => q.eq('status', 'completed'))
      .collect();
    return rows
      .filter((p) => p.paidAt != null && p.paidAt >= args.from && p.paidAt < args.to)
      .map((p) => ({ partnerId: p.partnerId, amountCents: p.amountCents ?? 0 }));
  },
});

/** (amountCents, status) across ALL payouts — finance "paid out to date" read
 *  (sum where completed). Mirrors `.from('AffiliatePayout').select('amountCents, status')`. */
export const allAmountStatus = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('AffiliatePayout').collect();
    return rows.map((p) => ({ amountCents: p.amountCents ?? 0, status: p.status }));
  },
});

export { payoutStatusValidator };
export type { PayoutFields };
