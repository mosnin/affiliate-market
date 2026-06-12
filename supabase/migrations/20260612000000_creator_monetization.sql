-- Creator monetization: platform fee + Stripe Connect payouts + product links.
--
-- Cola takes a flat 20% platform fee out of creator (affiliate) earnings.
-- Commissions now carry the split: amountCents stays the GROSS commission the
-- seller owes; platformFeeCents is Cola's cut; netCents is what the creator
-- is actually paid. Payouts transfer netCents to the creator's connected
-- Stripe account when one exists.

ALTER TABLE "AffiliatePartner"
  ADD COLUMN IF NOT EXISTS "stripeAccountId" TEXT;

ALTER TABLE "AffiliateCommission"
  ADD COLUMN IF NOT EXISTS "platformFeeCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AffiliateCommission"
  ADD COLUMN IF NOT EXISTS "netCents" INTEGER;

-- Backfill: existing commissions predate the fee — creator keeps 100%.
UPDATE "AffiliateCommission" SET "netCents" = "amountCents" WHERE "netCents" IS NULL;

ALTER TABLE "AffiliatePayout"
  ADD COLUMN IF NOT EXISTS "platformFeeCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AffiliatePayout"
  ADD COLUMN IF NOT EXISTS "stripeTransferId" TEXT;

-- Explore links point at a specific product (destinationUrl carries the path;
-- productId makes per-product creator analytics queryable).
ALTER TABLE "ReferralLink"
  ADD COLUMN IF NOT EXISTS "productId" TEXT REFERENCES "Product"(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_referral_link_product
  ON "ReferralLink" ("productId") WHERE "productId" IS NOT NULL;
