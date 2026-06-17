import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * AffiliateCommission data access — the MONEY-CORE table. Convex replacement for
 * the `.from('AffiliateCommission')` reads & writes across conversions,
 * recurring, tier2, commissions, payouts, settlement, reversals, stats,
 * link-analytics, admin-metrics, finance.
 *
 * MONEY (CLAUDE.md): amountCents = GROSS (seller owes), platformFeeCents =
 * Cola's 20% cut, netCents = creator NET. The 20% split is computed in
 * lib/affiliates/fees.ts#splitCommissionCents and PASSED IN — these inserts only
 * STORE the gross/fee/net values. Nothing here recomputes a money formula.
 *
 * Invariant preserved: idx_affiliate_commission_stripe_invoice UNIQUE(
 * stripeInvoiceId) WHERE NOT NULL — one commission per Stripe invoice (recurring
 * idempotency). insertPaymentCommission reads by_stripe_invoice before insert
 * (the race-free version of the old "insert, treat duplicate as success").
 *
 * Hold/settlement gating (the lib does the filtering; these reads return the raw
 * fields it filters on):
 *   - matureAt <= now  → refund window passed (payable).
 *   - source='marketplace' OR settledAt set → bridge never fronted before the
 *     seller settles.
 *
 * CROSS-DOMAIN STAYS IN LIB: recordConversion / recordPaymentCommission also
 * touch links, partners, programs, referrals, emails, tier2 — those stay lib
 * calls (each its own Convex module). This module owns only the
 * AffiliateCommission hops.
 */

const statusValidator = v.union(
  v.literal('pending'),
  v.literal('approved'),
  v.literal('paid'),
  v.literal('rejected'),
  v.literal('reversed'),
);
const sourceValidator = v.union(v.literal('marketplace'), v.literal('stripe_bridge'));

type CommissionFields = {
  id: string;
  spaceId: string;
  partnerId: string;
  referralId?: string;
  orderId?: string;
  amountCents: number;
  currency: string;
  status: 'pending' | 'approved' | 'paid' | 'rejected' | 'reversed';
  level: number;
  payoutId?: string;
  note?: string;
  createdAt: string;
  approvedAt?: string;
  platformFeeCents: number;
  netCents?: number;
  source: 'marketplace' | 'stripe_bridge';
  periodNumber: number;
  stripeInvoiceId?: string;
  settledAt?: string;
  settlementInvoiceId?: string;
  reversedAt?: string;
  reversalReason?: string;
  matureAt?: string;
};

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Insert the level-1 commission for a marketplace conversion (recordConversion).
 * The lib computed: commissionCents (GROSS), platformFeeCents, netCents (the 20%
 * split), status (rejected for self-referral / approved / pending), matureAt
 * (createdAt + holdDays), and the self-referral note. We STORE them verbatim.
 * approvedAt is set iff status==='approved'.
 */
export const insertConversionCommission = mutation({
  args: {
    spaceId: v.string(),
    partnerId: v.string(),
    referralId: v.string(),
    orderId: v.string(),
    amountCents: v.number(), // GROSS
    platformFeeCents: v.number(),
    netCents: v.number(),
    currency: v.string(),
    status: statusValidator,
    matureAt: v.union(v.string(), v.null()),
    note: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<void> => {
    const now = new Date().toISOString();
    await ctx.db.insert('AffiliateCommission', {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      partnerId: args.partnerId,
      referralId: args.referralId,
      orderId: args.orderId,
      amountCents: args.amountCents,
      currency: args.currency || 'usd',
      status: args.status,
      level: 1,
      platformFeeCents: args.platformFeeCents,
      netCents: args.netCents,
      source: 'marketplace',
      periodNumber: 1,
      ...(args.matureAt !== null ? { matureAt: args.matureAt } : {}),
      ...(args.note !== null ? { note: args.note } : {}),
      ...(args.status === 'approved' ? { approvedAt: now } : {}),
      createdAt: now,
    });
  },
});

/**
 * Insert a commission for a VERIFIED payment event (recordPaymentCommission:
 * first sale or renewal). Idempotent on stripeInvoiceId via by_stripe_invoice —
 * returns inserted:false when one already exists (the lib's "already recorded"
 * early-out / lost-race-is-success path). The lib computed gross/fee/net (the
 * 20% split), status, matureAt, periodNumber, source, and the renewal note; we
 * STORE them. approvedAt set iff approved.
 */
export const insertPaymentCommission = mutation({
  args: {
    spaceId: v.string(),
    partnerId: v.string(),
    referralId: v.string(),
    orderId: v.union(v.string(), v.null()),
    amountCents: v.number(), // GROSS
    platformFeeCents: v.number(),
    netCents: v.number(),
    currency: v.string(),
    status: statusValidator,
    matureAt: v.union(v.string(), v.null()),
    source: sourceValidator,
    periodNumber: v.number(),
    stripeInvoiceId: v.string(),
    note: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<{ inserted: boolean }> => {
    // UNIQUE(stripeInvoiceId) — one commission per invoice.
    const dup = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_stripe_invoice', (q) => q.eq('stripeInvoiceId', args.stripeInvoiceId))
      .first();
    if (dup) return { inserted: false };

    const now = new Date().toISOString();
    await ctx.db.insert('AffiliateCommission', {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      partnerId: args.partnerId,
      referralId: args.referralId,
      ...(args.orderId !== null ? { orderId: args.orderId } : {}),
      amountCents: args.amountCents,
      currency: args.currency || 'usd',
      status: args.status,
      level: 1,
      platformFeeCents: args.platformFeeCents,
      netCents: args.netCents,
      source: args.source,
      periodNumber: args.periodNumber,
      stripeInvoiceId: args.stripeInvoiceId,
      ...(args.matureAt !== null ? { matureAt: args.matureAt } : {}),
      ...(args.note !== null ? { note: args.note } : {}),
      ...(args.status === 'approved' ? { approvedAt: now } : {}),
      createdAt: now,
    });
    return { inserted: true };
  },
});

/**
 * Insert the level-2 sub-affiliate override (maybeCreateTierTwoCommission). The
 * lib computed the tier-2 gross (childGross * tier2Percent) + the 20% split and
 * the autoApprove status; we STORE them. stripeInvoiceId is intentionally absent
 * (the parent piggybacks on the level-1 invoice idempotency — must not collide).
 * source is always 'marketplace', level 2, the fixed tier-2 note.
 */
export const insertTier2Commission = mutation({
  args: {
    spaceId: v.string(),
    partnerId: v.string(),
    referralId: v.union(v.string(), v.null()),
    orderId: v.union(v.string(), v.null()),
    amountCents: v.number(), // GROSS (tier-2)
    platformFeeCents: v.number(),
    netCents: v.number(),
    currency: v.string(),
    autoApprove: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const now = new Date().toISOString();
    await ctx.db.insert('AffiliateCommission', {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      partnerId: args.partnerId,
      ...(args.referralId !== null ? { referralId: args.referralId } : {}),
      ...(args.orderId !== null ? { orderId: args.orderId } : {}),
      amountCents: args.amountCents,
      currency: args.currency || 'usd',
      status: args.autoApprove ? 'approved' : 'pending',
      level: 2,
      platformFeeCents: args.platformFeeCents,
      netCents: args.netCents,
      source: 'marketplace',
      periodNumber: 1,
      note: 'Sub-affiliate override (tier 2)',
      ...(args.autoApprove ? { approvedAt: now } : {}),
      createdAt: now,
    });
  },
});

/** Approve a commission (status pending -> approved, stamp approvedAt). CAS on
 *  status==='pending' — returns false if it wasn't pending (lib treats as no-op).
 *  Mirrors `.update(status=approved,approvedAt).eq('id').eq('status','pending')`. */
export const approve = mutation({
  args: { commissionId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const c = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_app_id', (q) => q.eq('id', args.commissionId))
      .unique();
    if (!c) return false;
    if (c.status !== 'pending') return false;
    await ctx.db.patch(c._id, { status: 'approved', approvedAt: new Date().toISOString() });
    return true;
  },
});

/** Reject a commission (status pending|approved -> rejected). CAS on status in
 *  (pending, approved). Mirrors `.update(status=rejected).eq('id').in('status',[...])`. */
export const reject = mutation({
  args: { commissionId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const c = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_app_id', (q) => q.eq('id', args.commissionId))
      .unique();
    if (!c) return false;
    if (c.status !== 'pending' && c.status !== 'approved') return false;
    await ctx.db.patch(c._id, { status: 'rejected' });
    return true;
  },
});

/**
 * Reverse one commission (refund/dispute clawback). Idempotent: a row already
 * 'reversed'/'rejected' is left alone (returns reversed:false). Sets status
 * 'reversed', reversedAt, reversalReason. Reports wasPaid + netCents so the lib
 * drives the partner balance clawback (partners.adjustBalance) — the cross-table
 * write stays in lib per CONVENTIONS. Replaces the reversal `.update(...)
 * .eq('id').neq('status','reversed')`.
 */
export const reverseOne = mutation({
  args: { commissionId: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_app_id', (q) => q.eq('id', args.commissionId))
      .unique();
    if (!c) return { reversed: false as const, wasPaid: false, netCents: 0 };
    if (c.status === 'reversed' || c.status === 'rejected') {
      return { reversed: false as const, wasPaid: false, netCents: 0 };
    }
    const wasPaid = c.status === 'paid';
    const settledNote =
      c.source === 'stripe_bridge' && c.settledAt
        ? ' (bridge commission already settled by seller — reconcile manually)'
        : '';
    await ctx.db.patch(c._id, {
      status: 'reversed',
      reversedAt: new Date().toISOString(),
      reversalReason: `${args.reason}${settledNote}`,
    });
    return { reversed: true as const, wasPaid, netCents: c.netCents ?? c.amountCents ?? 0 };
  },
});

/** Mark a set of commissions paid (+ attach payoutId when given) — the payout
 *  consume step. Mirrors `.update({status:'paid'[,payoutId]}).in('id', ids)`. */
export const markPaid = mutation({
  args: { commissionIds: v.array(v.string()), payoutId: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<void> => {
    for (const id of args.commissionIds) {
      const c = await ctx.db
        .query('AffiliateCommission')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (!c) continue;
      await ctx.db.patch(c._id, {
        status: 'paid',
        ...(args.payoutId !== null ? { payoutId: args.payoutId } : {}),
      });
    }
  },
});

/** Stamp a set of bridge commissions settled (runBridgeSettlement, after the
 *  Stripe invoice is created in lib). Mirrors `.update({settledAt,
 *  settlementInvoiceId}).in('id', ids)`. */
export const markSettled = mutation({
  args: {
    commissionIds: v.array(v.string()),
    settledAt: v.string(),
    settlementInvoiceId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    for (const id of args.commissionIds) {
      const c = await ctx.db
        .query('AffiliateCommission')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (!c) continue;
      await ctx.db.patch(c._id, {
        settledAt: args.settledAt,
        settlementInvoiceId: args.settlementInvoiceId,
      });
    }
  },
});

// ── Reads ────────────────────────────────────────────────────────────────────

/** (id, spaceId) for a commission — the approve/reject route ownership check.
 *  Mirrors `.select('id, spaceId').eq('id').maybeSingle()`. */
export const ownerCheck = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c) return null;
    return { id: c.id, spaceId: c.spaceId };
  },
});

/** Raw commission rows for a space, newest-first (cap 200), optional status
 *  filter — listCommissions' base read (the lib joins partner name/email).
 *  Returns (id, partnerId, referralId, orderId, amountCents, currency, status,
 *  createdAt, approvedAt). amountCents here is GROSS (the seller-facing list). */
export const listForSpace = query({
  args: { spaceId: v.string(), status: v.optional(statusValidator) },
  handler: async (ctx, args) => {
    let rows = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    if (args.status !== undefined) rows = rows.filter((c) => c.status === args.status);
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.slice(0, 200).map((c) => ({
      id: c.id,
      partnerId: c.partnerId,
      referralId: c.referralId ?? null,
      orderId: c.orderId ?? null,
      amountCents: c.amountCents ?? 0,
      currency: c.currency ?? 'usd',
      status: c.status,
      createdAt: c.createdAt,
      approvedAt: c.approvedAt ?? null,
    }));
  },
});

/** Recent commissions for one partner, newest-first (cap `limit`) —
 *  listCommissionsForPartner (affiliate dashboard). Returns (id, orderId,
 *  amountCents, currency, status, createdAt). NOTE: the lib surfaces these to a
 *  creator, so callers read net elsewhere; this mirrors the existing select. */
export const listForPartner = query({
  args: { partnerId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_partner_status', (q) => q.eq('partnerId', args.partnerId))
      .collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.slice(0, args.limit ?? 50).map((c) => ({
      id: c.id,
      orderId: c.orderId ?? null,
      amountCents: c.amountCents ?? 0,
      currency: c.currency ?? 'usd',
      status: c.status,
      createdAt: c.createdAt,
    }));
  },
});

/** (partnerId, amountCents, status) for a space — listPartners' earnings rollup.
 *  amountCents is GROSS (the seller-facing partner table). */
export const partnerAmountsForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.map((c) => ({
      partnerId: c.partnerId,
      amountCents: c.amountCents ?? 0,
      status: c.status,
    }));
  },
});

/** (amountCents, status) for a space — getProgramStats' commission read (GROSS). */
export const amountStatusForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.map((c) => ({ amountCents: c.amountCents ?? 0, status: c.status }));
  },
});

/** (amountCents, netCents, status) across a creator's partner ids — the NET stats
 *  read (getAffiliateStatsForPartners). Optional `since` (digest) filters by
 *  createdAt + restricts to approved|paid. */
export const netStatsForPartners = query({
  args: { partnerIds: v.array(v.string()), since: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const out: Array<{ amountCents: number; netCents: number | null; status: string }> = [];
    for (const partnerId of args.partnerIds) {
      const rows = await ctx.db
        .query('AffiliateCommission')
        .withIndex('by_partner_status', (q) => q.eq('partnerId', partnerId))
        .collect();
      for (const c of rows) {
        if (args.since !== undefined) {
          if (c.createdAt < args.since) continue;
          if (c.status !== 'approved' && c.status !== 'paid') continue;
        }
        out.push({ amountCents: c.amountCents ?? 0, netCents: c.netCents ?? null, status: c.status });
      }
    }
    return out;
  },
});

/** Distinct partnerIds with an APPROVED commission in a space — runPayoutBatch's
 *  candidate set. Mirrors `.select('partnerId').eq('spaceId').eq('status','approved')`. */
export const approvedPartnerIdsForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const rows = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', 'approved'))
      .collect();
    return [...new Set(rows.map((c) => c.partnerId))];
  },
});

/**
 * Approved + matured + payable commissions for a (space, partner) — the createPayout
 * selection. "Payable" = status approved AND matureAt <= now AND (source=
 * marketplace OR settledAt set). Returns (id, amountCents, netCents,
 * platformFeeCents, createdAt) so the lib sums net/fee and dates the period.
 * Mirrors `.eq('spaceId').eq('partnerId').eq('status','approved').lte('matureAt',now)
 * .or('source.eq.marketplace,settledAt.not.is.null')`.
 */
export const payableForPartnerInSpace = query({
  args: { spaceId: v.string(), partnerId: v.string(), now: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_partner_status', (q) =>
        q.eq('partnerId', args.partnerId).eq('status', 'approved'),
      )
      .collect();
    return rows
      .filter((c) => c.spaceId === args.spaceId)
      .filter((c) => c.matureAt != null && c.matureAt <= args.now)
      .filter((c) => c.source === 'marketplace' || c.settledAt != null)
      .map((c) => ({
        id: c.id,
        amountCents: c.amountCents ?? 0,
        netCents: c.netCents ?? null,
        platformFeeCents: c.platformFeeCents ?? 0,
        createdAt: c.createdAt,
      }));
  },
});

/** (amountCents, netCents) of approved+matured+payable commissions across a
 *  creator's partner ids — getPayableBalanceCentsForPartners' commission read.
 *  Same payable predicate as above, partner-set scoped (not space-scoped). */
export const payableNetForPartners = query({
  args: { partnerIds: v.array(v.string()), now: v.string() },
  handler: async (ctx, args) => {
    const out: Array<{ amountCents: number; netCents: number | null }> = [];
    for (const partnerId of args.partnerIds) {
      const rows = await ctx.db
        .query('AffiliateCommission')
        .withIndex('by_partner_status', (q) =>
          q.eq('partnerId', partnerId).eq('status', 'approved'),
        )
        .collect();
      for (const c of rows) {
        if (!(c.matureAt != null && c.matureAt <= args.now)) continue;
        if (!(c.source === 'marketplace' || c.settledAt != null)) continue;
        out.push({ amountCents: c.amountCents ?? 0, netCents: c.netCents ?? null });
      }
    }
    return out;
  },
});

/** Period count for a referral: how many non-rejected commissions it already has
 *  (recordPaymentCommission's periodNumber = count + 1). Mirrors
 *  `.eq('referralId').neq('status','rejected')` count. by_referral index. */
export const nonRejectedCountForReferral = query({
  args: { referralId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_referral', (q) => q.eq('referralId', args.referralId))
      .collect();
    return rows.filter((c) => c.status !== 'rejected').length;
  },
});

/** (referralId, netCents, amountCents, status) for a set of referral ids,
 *  restricted to approved|paid — link-analytics' net-per-link join. Mirrors
 *  `.in('referralId', ids).in('status', ['approved','paid'])`. */
export const earnedNetForReferrals = query({
  args: { referralIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Array<{
      referralId: string | null;
      netCents: number | null;
      amountCents: number;
      status: string;
    }> = [];
    for (const referralId of args.referralIds) {
      const rows = await ctx.db
        .query('AffiliateCommission')
        .withIndex('by_referral', (q) => q.eq('referralId', referralId))
        .collect();
      for (const c of rows) {
        if (c.status !== 'approved' && c.status !== 'paid') continue;
        out.push({
          referralId: c.referralId ?? null,
          netCents: c.netCents ?? null,
          amountCents: c.amountCents ?? 0,
          status: c.status,
        });
      }
    }
    return out;
  },
});

/** All commissions tied to one marketplace order — reverseCommissionsForOrder's
 *  read. Returns the fields reverseRows needs. by_order index. */
export const forOrder = query({
  args: { orderId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_order', (q) => q.eq('orderId', args.orderId))
      .collect();
    return rows.map((c) => ({
      id: c.id,
      partnerId: c.partnerId,
      status: c.status,
      netCents: c.netCents ?? null,
      amountCents: c.amountCents ?? 0,
      source: c.source,
      settledAt: c.settledAt ?? null,
    }));
  },
});

/** All commissions tied to one Stripe invoice — reverseCommissionsForInvoice's
 *  read. by_stripe_invoice index. */
export const forStripeInvoice = query({
  args: { stripeInvoiceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_stripe_invoice', (q) => q.eq('stripeInvoiceId', args.stripeInvoiceId))
      .collect();
    return rows.map((c) => ({
      id: c.id,
      partnerId: c.partnerId,
      status: c.status,
      netCents: c.netCents ?? null,
      amountCents: c.amountCents ?? 0,
      source: c.source,
      settledAt: c.settledAt ?? null,
    }));
  },
});

/** Unsettled bridge commissions for a space — settlement's read (getBridgeOwed /
 *  runBridgeSettlement). Predicate: source='stripe_bridge' AND status!='rejected'
 *  AND settledAt IS NULL. Returns (id, amountCents) [GROSS — what the seller owes].
 *  Mirrors `.eq('spaceId').eq('source','stripe_bridge').neq('status','rejected')
 *  .is('settledAt', null)`. */
export const unsettledBridgeForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliateCommission')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows
      .filter((c) => c.source === 'stripe_bridge' && c.status !== 'rejected' && c.settledAt == null)
      .map((c) => ({ id: c.id, amountCents: c.amountCents ?? 0 }));
  },
});

/** Distinct space ids that owe unsettled bridge commissions (settlement cron).
 *  Predicate as above, all spaces. Mirrors the `.select('spaceId')...` scan. */
export const spaceIdsWithBridgeDebt = query({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const rows = await ctx.db.query('AffiliateCommission').collect();
    const ids = new Set<string>();
    for (const c of rows) {
      if (c.source === 'stripe_bridge' && c.status !== 'rejected' && c.settledAt == null) {
        ids.add(c.spaceId);
      }
    }
    return [...ids];
  },
});

/** (platformFeeCents, status) across ALL commissions — getPlatformRevenueCents'
 *  affiliate-fee read (sum where approved|paid). Operator-facing GROSS fee. */
export const allPlatformFees = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('AffiliateCommission').collect();
    return rows.map((c) => ({ platformFeeCents: c.platformFeeCents ?? 0, status: c.status }));
  },
});

/** Full finance projection across ALL commissions — the affiliate-finance page
 *  read (spaceId, amountCents, platformFeeCents, netCents, status, source,
 *  settledAt). Mirrors `.select('spaceId, amountCents, platformFeeCents, netCents,
 *  status, source, settledAt')`. */
export const financeProjection = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('AffiliateCommission').collect();
    return rows.map((c) => ({
      spaceId: c.spaceId,
      amountCents: c.amountCents ?? 0,
      platformFeeCents: c.platformFeeCents ?? 0,
      netCents: c.netCents ?? null,
      status: c.status,
      source: c.source,
      settledAt: c.settledAt ?? null,
    }));
  },
});

/** Distinct space ids with a commission created since `since` (digest active-
 *  spaces). Mirrors `.from('AffiliateCommission').select('spaceId').gte('createdAt', since)`. */
export const spaceIdsWithCommissionSince = query({
  args: { since: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const rows = await ctx.db.query('AffiliateCommission').collect();
    const ids = new Set<string>();
    for (const c of rows) if (c.createdAt >= args.since) ids.add(c.spaceId);
    return [...ids];
  },
});

export type { CommissionFields };
