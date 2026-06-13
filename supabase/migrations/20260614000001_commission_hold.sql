-- Refund-hold + payout discipline: protect the platform from fronting money
-- it can't claw back.
--
--   * matureAt: a commission isn't payable until the refund window passes.
--     Set when the commission is created (createdAt + program.holdDays).
--     Payouts only pay commissions that are approved AND matured.
--   * holdDays: per-program refund window (default 14).
--   * minPayoutCents: don't cut a payout below this (Stripe fees + ops).
--
-- Bridge sales additionally require the seller to have SETTLED (settledAt set)
-- before the creator is paid — the platform never fronts a bridge payout. That
-- gate lives in the payout query (no schema change needed; settledAt already
-- exists from the settlement migration).

ALTER TABLE "AffiliateCommission"
  ADD COLUMN IF NOT EXISTS "matureAt" TIMESTAMPTZ;

-- Backfill: existing commissions are already past any window — payable now.
UPDATE "AffiliateCommission" SET "matureAt" = "createdAt" WHERE "matureAt" IS NULL;

ALTER TABLE "AffiliateProgram"
  ADD COLUMN IF NOT EXISTS "holdDays" INTEGER NOT NULL DEFAULT 14;
ALTER TABLE "AffiliateProgram"
  ADD COLUMN IF NOT EXISTS "minPayoutCents" INTEGER NOT NULL DEFAULT 2000;

ALTER TABLE "AffiliateProgram" DROP CONSTRAINT IF EXISTS "AffiliateProgram_holdDays_check";
ALTER TABLE "AffiliateProgram" ADD CONSTRAINT "AffiliateProgram_holdDays_check"
  CHECK ("holdDays" >= 0 AND "holdDays" <= 180);

CREATE INDEX IF NOT EXISTS idx_affiliate_commission_payable
  ON "AffiliateCommission" ("partnerId", status, "matureAt");
