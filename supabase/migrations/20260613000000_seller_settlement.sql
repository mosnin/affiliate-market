-- Seller-side money: receive marketplace proceeds, settle bridge commissions.
--
-- Closes the money loop on both sale types:
--   * Marketplace sale → platform holds the charge; the seller connects a
--     Stripe Express account and their proceeds (sale minus the gross
--     creator commission) transfer automatically on payment.
--   * Bridge sale → the seller's own Stripe holds the charge; the gross
--     commission they owe accrues here and is settled by invoicing the
--     seller's existing billing customer ("Space"."stripeCustomerId").

ALTER TABLE "Space"
  ADD COLUMN IF NOT EXISTS "stripeConnectAccountId" TEXT;

ALTER TABLE "MarketplaceOrder"
  ADD COLUMN IF NOT EXISTS "sellerPayoutCents" INTEGER;
ALTER TABLE "MarketplaceOrder"
  ADD COLUMN IF NOT EXISTS "sellerTransferId" TEXT;

ALTER TABLE "AffiliateCommission"
  ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMPTZ;
ALTER TABLE "AffiliateCommission"
  ADD COLUMN IF NOT EXISTS "settlementInvoiceId" TEXT;

-- Settlement scans: unsettled bridge commissions per space.
CREATE INDEX IF NOT EXISTS idx_affiliate_commission_unsettled_bridge
  ON "AffiliateCommission" ("spaceId")
  WHERE source = 'stripe_bridge' AND "settledAt" IS NULL;
