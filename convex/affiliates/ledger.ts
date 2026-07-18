import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * CommissionLedger data access — the Convex replacement for the
 * `.from('CommissionLedger')` reads & writes in app/manager/commissions/page.tsx,
 * app/api/manager/commissions/export, and app/api/manager/commissions/ledger/[id].
 *
 * This is the REAL-ESTATE GCI ledger (one snapshot row per won deal), separate
 * from the affiliate commission core. Money is numeric DOLLARS (dealValue,
 * agent/manager/referralAmount) — NOT cents.
 *
 * Rows are normally minted by the Deal->'won' Postgres trigger
 * (UNIQUE(dealId) ON CONFLICT DO NOTHING). The app only reads + PATCHes them; the
 * PATCH recomputes amounts from the (unchanged) dealValue when a rate changes —
 * that math + all validation stays in the route. These functions do the DB hops,
 * preserving the route's companyId scoping (TOCTOU guard) on read/update. The
 * User/Deal embedded joins (agent name/email, deal title) resolve in lib (those
 * tables are not this domain) — exactly the page's existing two-query fallback.
 *
 * insertFromDealWon reimplements the trigger for completeness (the integrator can
 * call it from the Deal->won lib path if/when Deal moves to Convex); it preserves
 * UNIQUE(dealId) via read-then-insert (the trigger's ON CONFLICT DO NOTHING).
 */

const ledgerStatusValidator = v.union(
  v.literal('pending'),
  v.literal('paid'),
  v.literal('void'),
);

type LedgerFields = {
  id: string;
  companyId: string;
  agentUserId?: string;
  dealId?: string;
  closedAt: string;
  dealValue: number;
  agentRate: number;
  managerRate: number;
  referralRate: number;
  referralUserId?: string;
  agentAmount: number;
  managerAmount: number;
  referralAmount: number;
  status: 'pending' | 'paid' | 'void';
  payoutAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

/** Raw CommissionLedger row (the page/export read `*`, then join User/Deal in
 *  lib). Surface `id`, absent optionals -> null, so the LedgerDbRow shape holds. */
function toLedgerRow(r: LedgerFields) {
  return {
    id: r.id,
    companyId: r.companyId,
    agentUserId: r.agentUserId ?? null,
    dealId: r.dealId ?? null,
    closedAt: r.closedAt,
    dealValue: r.dealValue ?? 0,
    agentRate: r.agentRate ?? 0,
    managerRate: r.managerRate ?? 0,
    referralRate: r.referralRate ?? 0,
    referralUserId: r.referralUserId ?? null,
    agentAmount: r.agentAmount ?? 0,
    managerAmount: r.managerAmount ?? 0,
    referralAmount: r.referralAmount ?? 0,
    status: r.status,
    payoutAt: r.payoutAt ?? null,
    notes: r.notes ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** A company's ledger rows, closedAt DESC (cap 5000) — the page read. The lib
 *  resolves agent (User) + deal (Deal) names afterwards. by_company index.
 *  Mirrors `.eq('companyId').order('closedAt' desc).limit(5000)`. */
export const listForCompany = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CommissionLedger')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .order('desc')
      .take(5000);
    return rows.map(toLedgerRow);
  },
});

/** A company's ledger rows in a closedAt window, closedAt ASC — the export read.
 *  Optional status filter. The lib resolves the User/Deal joins. Mirrors
 *  `.eq('companyId').gte('closedAt', start).lt('closedAt', next).order('closedAt' asc)
 *  [.eq('status', status)]`. */
export const listForCompanyInWindow = query({
  args: {
    companyId: v.string(),
    start: v.string(),
    next: v.string(),
    status: v.optional(ledgerStatusValidator),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CommissionLedger')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .collect();
    return rows
      .filter((r) => r.closedAt >= args.start && r.closedAt < args.next)
      .filter((r) => (args.status === undefined ? true : r.status === args.status))
      .sort((a, b) => (a.closedAt < b.closedAt ? -1 : a.closedAt > b.closedAt ? 1 : 0))
      .map(toLedgerRow);
  },
});

/** One ledger row scoped to (id, companyId), or null — the PATCH route's load.
 *  Mirrors `.eq('id').eq('companyId').maybeSingle()`. */
export const getScoped = query({
  args: { id: v.string(), companyId: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('CommissionLedger')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.companyId !== args.companyId) return null;
    return toLedgerRow(r);
  },
});

/**
 * Patch a ledger row, scoped to (id, companyId) (PATCH route). The route
 * validated everything (status, payoutAt, rate ranges, rate-sum<=100, the
 * referralRate<->referralUserId pair invariant) and recomputed agent/manager/
 * referralAmount from the existing dealValue when a rate changed — it passes the
 * final amounts. Each arg is a union with null where the route allows clearing
 * (payoutAt / referralUserId / notes); absent (undefined) leaves the column.
 * updatedAt is stamped. Returns the updated row, or null on a lost scope race.
 */
export const patchScoped = mutation({
  args: {
    id: v.string(),
    companyId: v.string(),
    status: v.optional(ledgerStatusValidator),
    payoutAt: v.optional(v.union(v.string(), v.null())),
    agentRate: v.optional(v.number()),
    managerRate: v.optional(v.number()),
    referralRate: v.optional(v.number()),
    referralUserId: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    // Recomputed amounts (route computes from dealValue when a rate changed).
    agentAmount: v.optional(v.number()),
    managerAmount: v.optional(v.number()),
    referralAmount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('CommissionLedger')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.companyId !== args.companyId) return null;

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.payoutAt !== undefined) patch.payoutAt = args.payoutAt === null ? undefined : args.payoutAt;
    if (args.agentRate !== undefined) patch.agentRate = args.agentRate;
    if (args.managerRate !== undefined) patch.managerRate = args.managerRate;
    if (args.referralRate !== undefined) patch.referralRate = args.referralRate;
    if (args.referralUserId !== undefined)
      patch.referralUserId = args.referralUserId === null ? undefined : args.referralUserId;
    if (args.notes !== undefined) patch.notes = args.notes === null ? undefined : args.notes;
    if (args.agentAmount !== undefined) patch.agentAmount = args.agentAmount;
    if (args.managerAmount !== undefined) patch.managerAmount = args.managerAmount;
    if (args.referralAmount !== undefined) patch.referralAmount = args.referralAmount;

    await ctx.db.patch(r._id, patch);
    const updated = (await ctx.db.get(r._id))!;
    return toLedgerRow(updated);
  },
});

/**
 * Reimplements the Deal->'won' trigger insert. Preserves UNIQUE(dealId) (the
 * trigger's ON CONFLICT (dealId) DO NOTHING): reads by_deal first and no-ops if a
 * row already exists. The caller (a future Deal-won lib path) passes the deal
 * value + the company's agent/manager rates; agentAmount/managerAmount are
 * ROUND(value * rate / 100, 2). referralRate/Amount default 0, status 'pending'.
 * No current app call site INSERTs CommissionLedger — included so the trigger's
 * behavior survives the Supabase removal.
 */
export const insertFromDealWon = mutation({
  args: {
    companyId: v.string(),
    agentUserId: v.union(v.string(), v.null()),
    dealId: v.string(),
    dealValue: v.number(), // numeric dollars
    agentRate: v.number(), // numeric percent
    managerRate: v.number(), // numeric percent
  },
  handler: async (ctx, args): Promise<{ inserted: boolean }> => {
    // UNIQUE(dealId) — one ledger row per deal.
    const existing = await ctx.db
      .query('CommissionLedger')
      .withIndex('by_deal', (q) => q.eq('dealId', args.dealId))
      .first();
    if (existing) return { inserted: false };

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const now = new Date().toISOString();
    await ctx.db.insert('CommissionLedger', {
      id: crypto.randomUUID(),
      companyId: args.companyId,
      ...(args.agentUserId !== null ? { agentUserId: args.agentUserId } : {}),
      dealId: args.dealId,
      closedAt: now,
      dealValue: args.dealValue,
      agentRate: args.agentRate,
      managerRate: args.managerRate,
      referralRate: 0,
      agentAmount: round2((args.dealValue * args.agentRate) / 100),
      managerAmount: round2((args.dealValue * args.managerRate) / 100),
      referralAmount: 0,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    return { inserted: true };
  },
});

export type { LedgerFields };
