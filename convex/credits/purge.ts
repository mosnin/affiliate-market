import type { MutationCtx } from '../_generated/server';

/**
 * Delete every credit lot + txn for an account. The Convex replacement for the
 * PG trigger `purge_credit_rows_for_account` (which fired on Space / Company
 * DELETE). Convex has no FK cascade, so the Space / Company delete mutations
 * call this directly — it runs inside the caller's mutation transaction, so the
 * purge is atomic with the account delete (a deleted account never leaves orphan
 * credit rows behind).
 *
 * Scope is exactly (accountType, accountId): the `by_account` index on both
 * tables. CommissionLedger and other company-owned financial records are NOT
 * touched here — they are retained by design (see lib/account-deletion.ts).
 */
export async function purgeCreditRowsForAccount(
  ctx: MutationCtx,
  accountType: 'space' | 'company',
  accountId: string,
): Promise<void> {
  const lots = await ctx.db
    .query('CreditLot')
    .withIndex('by_account', (q) =>
      q.eq('accountType', accountType).eq('accountId', accountId),
    )
    .collect();
  for (const row of lots) await ctx.db.delete(row._id);

  const txns = await ctx.db
    .query('CreditTxn')
    .withIndex('by_account', (q) =>
      q.eq('accountType', accountType).eq('accountId', accountId),
    )
    .collect();
  for (const row of txns) await ctx.db.delete(row._id);
}
