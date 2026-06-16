import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * CreditLot data access — the Convex replacement for the Supabase reads and the
 * `grant_credits` Postgres function in lib/billing/credits.ts + lib/billing/grants.ts.
 *
 * The pure FIFO/balance math stays in lib/billing/credits.ts (unit-tested); only
 * the DB hops move here. Spend/refund live in ./txns.ts because they are
 * transaction-centric and write both CreditLot and CreditTxn.
 */

const accountTypeValidator = v.union(v.literal('space'), v.literal('company'));

/** Shape lib/billing/credits.ts#CreditLot expects for availableBalance(). */
export interface CreditLotBalanceRow {
  id: string;
  remaining: number;
  expiresAt: string | null;
}

function mapBalanceRow(lot: Doc<'CreditLot'>): CreditLotBalanceRow {
  return {
    id: lot.id,
    remaining: lot.remaining,
    // Convex omits absent optionals; the lib mapper boundary wants null = never-expires.
    expiresAt: lot.expiresAt ?? null,
  };
}

/**
 * Lots with credits left for an account (remaining > 0). Mirrors
 * `.from('CreditLot').select('id, remaining, expiresAt').eq(...).gt('remaining', 0)`.
 * The caller (getCreditBalance) runs availableBalance() over these to drop expired
 * lots and sum — keeping the FIFO/expiry rule in the unit-tested lib helper.
 */
export const balanceLots = query({
  args: { accountType: accountTypeValidator, accountId: v.string() },
  handler: async (ctx, args): Promise<CreditLotBalanceRow[]> => {
    const lots = await ctx.db
      .query('CreditLot')
      .withIndex('by_account', (q) =>
        q.eq('accountType', args.accountType).eq('accountId', args.accountId),
      )
      .collect();
    return lots.filter((l) => l.remaining > 0).map(mapBalanceRow);
  },
});

/**
 * Add a credit lot (monthly grant, top-up, free signup, add-on, migration,
 * manual admin). Replaces the `grant_credits` SQL function.
 *
 * Idempotency (preserving uq_creditlot_source): when `sourceId` is set, a lot
 * with the same (reason, sourceId) already existing makes this a no-op — a
 * retried Stripe webhook must not mint duplicate credits. The PG index is global
 * on (reason, sourceId); a given Stripe object belongs to one account, so we scope
 * the dedup scan to this account's lots off `by_account` (behaviorally identical,
 * and avoids a full-table index). Read-then-insert is serializable in one mutation.
 */
export const grant = mutation({
  args: {
    accountType: accountTypeValidator,
    accountId: v.string(),
    amount: v.number(),
    reason: v.string(),
    expiresAt: v.union(v.string(), v.null()),
    sourceId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<void> => {
    if (args.sourceId !== null) {
      const dup = await ctx.db
        .query('CreditLot')
        .withIndex('by_account', (q) =>
          q.eq('accountType', args.accountType).eq('accountId', args.accountId),
        )
        .filter((q) =>
          q.and(
            q.eq(q.field('reason'), args.reason),
            q.eq(q.field('sourceId'), args.sourceId),
          ),
        )
        .first();
      if (dup) return; // ON CONFLICT (reason, sourceId) DO NOTHING
    }
    await ctx.db.insert('CreditLot', {
      id: crypto.randomUUID(),
      accountType: args.accountType,
      accountId: args.accountId,
      amount: args.amount,
      remaining: args.amount, // grant starts fully un-spent
      reason: args.reason,
      ...(args.expiresAt !== null ? { expiresAt: args.expiresAt } : {}),
      createdAt: new Date().toISOString(),
      ...(args.sourceId !== null ? { sourceId: args.sourceId } : {}),
    });
  },
});

/**
 * True if this account already has a free-signup lot. Mirrors the pre-check in
 * grantFreeSignup() (`.from('CreditLot').select('id').eq(reason,'free_signup')`).
 * Backs the uq_creditlot_free_signup invariant: one free grant per account.
 */
export const hasFreeSignup = query({
  args: { accountType: accountTypeValidator, accountId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const existing = await ctx.db
      .query('CreditLot')
      .withIndex('by_account', (q) =>
        q.eq('accountType', args.accountType).eq('accountId', args.accountId),
      )
      .filter((q) => q.eq(q.field('reason'), 'free_signup'))
      .first();
    return existing !== null;
  },
});
