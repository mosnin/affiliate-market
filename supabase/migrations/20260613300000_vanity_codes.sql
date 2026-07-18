-- Vanity coupon codes: a memorable referral code (CASEY20) that both
-- attributes the sale to the creator AND discounts the buyer.
--
-- Built on ReferralLink — a vanity code is just a link with a human-chosen
-- code and an optional discount. Survives cookie loss (the buyer types it),
-- works in spoken media ("use code CASEY20"). The discount comes off the
-- buyer's price; the commission is computed on what the buyer actually pays.

ALTER TABLE "ReferralLink"
  ADD COLUMN IF NOT EXISTS "discountPercent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReferralLink"
  ADD COLUMN IF NOT EXISTS "isVanity" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ReferralLink" DROP CONSTRAINT IF EXISTS "ReferralLink_discountPercent_check";
ALTER TABLE "ReferralLink" ADD CONSTRAINT "ReferralLink_discountPercent_check"
  CHECK ("discountPercent" >= 0 AND "discountPercent" <= 90);

-- Record the discount actually applied to each order (for receipts/audit).
ALTER TABLE "MarketplaceOrder"
  ADD COLUMN IF NOT EXISTS "discountCents" INTEGER NOT NULL DEFAULT 0;
