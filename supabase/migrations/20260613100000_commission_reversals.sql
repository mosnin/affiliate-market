-- Money correctness: refunds and disputes claw commissions back.
--
-- A commission whose underlying payment came back is REVERSED:
--   * pending/approved → flipped to 'reversed' (never becomes payable)
--   * already paid     → flipped to 'reversed' AND the creator's
--     balanceAdjustmentCents goes negative; future payouts absorb the
--     debt before any new money moves.
-- Orders record when they were refunded; their licenses are revoked.

ALTER TABLE "AffiliateCommission" DROP CONSTRAINT IF EXISTS "AffiliateCommission_status_check";
ALTER TABLE "AffiliateCommission" ADD CONSTRAINT "AffiliateCommission_status_check"
  CHECK (status IN ('pending', 'approved', 'paid', 'rejected', 'reversed'));

ALTER TABLE "AffiliateCommission"
  ADD COLUMN IF NOT EXISTS "reversedAt" TIMESTAMPTZ;
ALTER TABLE "AffiliateCommission"
  ADD COLUMN IF NOT EXISTS "reversalReason" TEXT;

-- Negative = the creator owes the platform (refunded after payout).
ALTER TABLE "AffiliatePartner"
  ADD COLUMN IF NOT EXISTS "balanceAdjustmentCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "MarketplaceOrder"
  ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMPTZ;

-- Refund lookups arrive keyed by Stripe payment intent (charge.refunded).
ALTER TABLE "MarketplaceOrder"
  ADD COLUMN IF NOT EXISTS "stripePaymentIntentId" TEXT;
CREATE INDEX IF NOT EXISTS idx_marketplace_order_payment_intent
  ON "MarketplaceOrder" ("stripePaymentIntentId")
  WHERE "stripePaymentIntentId" IS NOT NULL;
