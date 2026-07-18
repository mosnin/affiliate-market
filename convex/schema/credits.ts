import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Credit ledger tables (Pricing V2, docs/PRICING_V2_PLAN.md §4.3). See
 * convex/CONVENTIONS.md for the Postgres -> Convex translation rules.
 *
 * Model: append-only credit *lots* (a grant/top-up that can expire) + *txns*
 * (every debit/refund, for audit). Balance = Σ remaining over non-expired lots.
 *
 * The old `accountType` CHECK ('space' | 'company') becomes a v.union literal.
 * Money/credits are integer counts -> v.number (never float). `metadata` jsonb
 * (carries the FIFO `debits` array a refund replays) -> v.any.
 *
 * Postgres uniqueness invariants that encoded real business behavior — they have
 * no native Convex equivalent, so the mutations re-implement them as read-then-
 * insert (serializable inside one mutation):
 *   - uq_creditlot_source: unique (reason, sourceId) WHERE sourceId IS NOT NULL
 *     -> idempotent grants; a retried webhook must not inflate credits.
 *   - uq_creditlot_free_signup: unique (accountType, accountId) WHERE
 *     reason = 'free_signup' -> exactly one free-signup grant per account.
 */
export const creditsTables = {
  // Was: "CreditLot" (TEXT id, accountType CHECK, accountId, amount, remaining,
  // reason, expiresAt nullable, createdAt, sourceId nullable).
  CreditLot: defineTable({
    id: v.string(),
    accountType: v.union(v.literal('space'), v.literal('company')),
    accountId: v.string(),
    amount: v.number(), // integer credits granted (CHECK amount > 0 in PG)
    remaining: v.number(), // integer credits left (CHECK remaining >= 0 in PG)
    reason: v.string(),
    expiresAt: v.optional(v.string()), // ISO-8601; absent = never expires (Free grant)
    createdAt: v.string(), // ISO-8601
    sourceId: v.optional(v.string()), // originating Stripe object id (idempotency key)
  })
    // refund + spend look lots up / decrement them by id.
    .index('by_app_id', ['id'])
    // Every read/write filters by (accountType, accountId): balance, grant dedup,
    // spend FIFO, refund re-grant. idx_creditlot_account in PG.
    .index('by_account', ['accountType', 'accountId']),

  // Was: "CreditTxn" (TEXT id, accountType CHECK, accountId, delta, workflow,
  // spaceId nullable, userId nullable, reason nullable, refundedTxnId nullable,
  // metadata jsonb, createdAt).
  CreditTxn: defineTable({
    id: v.string(),
    accountType: v.union(v.literal('space'), v.literal('company')),
    accountId: v.string(),
    delta: v.number(), // signed integer credits (negative = debit)
    workflow: v.string(),
    spaceId: v.optional(v.string()),
    userId: v.optional(v.string()),
    reason: v.optional(v.string()), // 'spend' | 'refund'
    refundedTxnId: v.optional(v.string()), // set on refund rows; points at the debit
    metadata: v.any(), // jsonb; spend rows carry { debits: [{lotId, take}], ... }
    createdAt: v.string(), // ISO-8601
  })
    // refund reads the original txn by id, and admin refund validates by id.
    .index('by_app_id', ['id'])
    // getRecentTxns + the cross-domain account filter. idx_credittxn_account in PG.
    .index('by_account', ['accountType', 'accountId'])
    // refund idempotency check: "is there already a refund row for this debit?"
    .index('by_refunded_txn', ['refundedTxnId']),
};
