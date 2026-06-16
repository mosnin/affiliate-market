import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * CreditTxn data access + the two atomic ledger mutations. Replaces the
 * `spend_credits` and `refund_credit_txn` Postgres functions and the
 * `.from('CreditTxn')` reads in lib/billing/credits.ts.
 *
 * spend + refund each write BOTH CreditLot and CreditTxn (both owned by this
 * domain), so each is ONE Convex mutation — serializable, which is strictly
 * stronger than the old `FOR UPDATE` row-locking in plpgsql. The FIFO debit
 * order here mirrors lib/billing/credits.ts#planDebit and the SQL exactly:
 * spendable lots, soonest-expiring first, never-expiring (null) last, then oldest.
 */

const accountTypeValidator = v.union(v.literal('space'), v.literal('company'));

/** A lot still expires-in-the-future-or-never AND has credits left. */
function spendable(lot: Doc<'CreditLot'>, nowMs: number): boolean {
  if (lot.remaining <= 0) return false;
  return lot.expiresAt == null || new Date(lot.expiresAt).getTime() > nowMs;
}

/** Recent ledger transactions, newest first. Mirrors getRecentTxns(). */
export interface CreditTxnRow {
  id: string;
  delta: number;
  workflow: string;
  reason: string | null;
  createdAt: string;
}

export const recentTxns = query({
  args: {
    accountType: accountTypeValidator,
    accountId: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args): Promise<CreditTxnRow[]> => {
    // by_account is (accountType, accountId); take newest-first then cap.
    const rows = await ctx.db
      .query('CreditTxn')
      .withIndex('by_account', (q) =>
        q.eq('accountType', args.accountType).eq('accountId', args.accountId),
      )
      .order('desc')
      .take(args.limit);
    return rows.map((t) => ({
      id: t.id,
      delta: t.delta,
      workflow: t.workflow,
      reason: t.reason ?? null,
      createdAt: t.createdAt,
    }));
  },
});

/** Account-binding fields for the admin refund guard. Mirrors the
 *  `.from('CreditTxn').select('accountType, accountId').eq('id', txnId)` lookup. */
export const txnAccountById = query({
  args: { id: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ accountType: 'space' | 'company'; accountId: string } | null> => {
    const txn = await ctx.db
      .query('CreditTxn')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!txn) return null;
    return { accountType: txn.accountType, accountId: txn.accountId };
  },
});

export interface SpendResult {
  ok: boolean;
  balance: number;
  txnId?: string;
}

/**
 * Atomically debit `amount` credits, FIFO oldest-expiring first. Fails closed
 * (ok:false) when the spendable balance is insufficient. Records a CreditTxn
 * carrying the per-lot `debits` so refund can replay them. Replaces spend_credits.
 */
export const spend = mutation({
  args: {
    accountType: accountTypeValidator,
    accountId: v.string(),
    amount: v.number(),
    workflow: v.string(),
    spaceId: v.union(v.string(), v.null()),
    userId: v.union(v.string(), v.null()),
    metadata: v.any(),
  },
  handler: async (ctx, args): Promise<SpendResult> => {
    if (args.amount == null || args.amount <= 0) {
      throw new Error(`spend_credits: amount must be a positive integer, got ${args.amount}`);
    }
    const nowMs = Date.now();
    const lots = (
      await ctx.db
        .query('CreditLot')
        .withIndex('by_account', (q) =>
          q.eq('accountType', args.accountType).eq('accountId', args.accountId),
        )
        .collect()
    ).filter((l) => spendable(l, nowMs));

    const balance = lots.reduce((s, l) => s + l.remaining, 0);
    if (balance < args.amount) {
      return { ok: false, balance, txnId: undefined };
    }

    // FIFO: soonest-expiring first, null (never-expires) last, then oldest-created.
    lots.sort((a, b) => {
      const an = a.expiresAt == null;
      const bn = b.expiresAt == null;
      if (an !== bn) return an ? 1 : -1; // nulls last
      if (!an && !bn && a.expiresAt !== b.expiresAt) {
        return new Date(a.expiresAt as string).getTime() - new Date(b.expiresAt as string).getTime();
      }
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });

    const debits: { lotId: string; take: number }[] = [];
    let need = args.amount;
    for (const lot of lots) {
      if (need <= 0) break;
      const take = Math.min(lot.remaining, need);
      await ctx.db.patch(lot._id, { remaining: lot.remaining - take });
      debits.push({ lotId: lot.id, take });
      need -= take;
    }

    const baseMeta =
      args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
        ? args.metadata
        : {};
    const txnId = crypto.randomUUID();
    await ctx.db.insert('CreditTxn', {
      id: txnId,
      accountType: args.accountType,
      accountId: args.accountId,
      delta: -args.amount,
      workflow: args.workflow,
      ...(args.spaceId !== null ? { spaceId: args.spaceId } : {}),
      ...(args.userId !== null ? { userId: args.userId } : {}),
      reason: 'spend',
      metadata: { ...baseMeta, debits },
      createdAt: new Date().toISOString(),
    });

    return { ok: true, balance: balance - args.amount, txnId };
  },
});

/**
 * Reverse a debit. Idempotent per txn (preserves refund_credit_txn): a no-op if
 * the txn isn't a 'spend', or if a refund row already points at it. Returns each
 * debited lot's credits to that lot while it's still spendable; if the original
 * lot expired/vanished, re-grants into a fresh 30-day lot so the credits don't
 * die in a dead lot. Writes a mirror refund CreditTxn. Replaces refund_credit_txn.
 */
export const refund = mutation({
  args: { txnId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const txn = await ctx.db
      .query('CreditTxn')
      .withIndex('by_app_id', (q) => q.eq('id', args.txnId))
      .unique();
    if (!txn || txn.reason !== 'spend') return; // IF NOT FOUND THEN RETURN

    const already = await ctx.db
      .query('CreditTxn')
      .withIndex('by_refunded_txn', (q) => q.eq('refundedTxnId', args.txnId))
      .first();
    if (already) return; // already refunded -> idempotent no-op

    const nowMs = Date.now();
    const debits: Array<{ lotId?: string; take?: number }> = Array.isArray(
      txn.metadata?.debits,
    )
      ? txn.metadata.debits
      : [];

    for (const d of debits) {
      const take = Number(d.take);
      if (!Number.isFinite(take) || take <= 0 || !d.lotId) continue;

      const lot = await ctx.db
        .query('CreditLot')
        .withIndex('by_app_id', (q) => q.eq('id', d.lotId as string))
        .unique();
      const lotSpendable =
        lot && (lot.expiresAt == null || new Date(lot.expiresAt).getTime() > nowMs);

      if (lot && lotSpendable) {
        await ctx.db.patch(lot._id, { remaining: lot.remaining + take });
      } else {
        // Original lot expired/gone -> fresh 30-day lot so refunded credits survive.
        const expiresAt = new Date(nowMs + 30 * 86400_000).toISOString();
        await ctx.db.insert('CreditLot', {
          id: crypto.randomUUID(),
          accountType: txn.accountType,
          accountId: txn.accountId,
          amount: take,
          remaining: take,
          reason: 'refund',
          expiresAt,
          createdAt: new Date().toISOString(),
        });
      }
    }

    await ctx.db.insert('CreditTxn', {
      id: crypto.randomUUID(),
      accountType: txn.accountType,
      accountId: txn.accountId,
      delta: -txn.delta, // reverse the debit (txn.delta is negative -> positive)
      workflow: txn.workflow,
      ...(txn.spaceId != null ? { spaceId: txn.spaceId } : {}),
      ...(txn.userId != null ? { userId: txn.userId } : {}),
      reason: 'refund',
      refundedTxnId: args.txnId,
      metadata: {},
      createdAt: new Date().toISOString(),
    });
  },
});
