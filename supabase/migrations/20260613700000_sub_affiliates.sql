-- Multi-level (2-tier) affiliates: a creator recruits other creators and
-- earns a second-tier override on the sub-affiliate's sales.
--
-- Off by default per program. When on, every level-1 commission a recruited
-- creator earns also creates a level-2 commission for their recruiter, worth
-- tier2Percent of the level-1 GROSS (then the platform fee splits off the
-- recruiter's cut too — the recruiter is a creator and sees net). Deliberately
-- capped at two tiers: no infinite pyramids.

ALTER TABLE "AffiliatePartner"
  ADD COLUMN IF NOT EXISTS "parentPartnerId" TEXT REFERENCES "AffiliatePartner"(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_affiliate_partner_parent
  ON "AffiliatePartner" ("parentPartnerId") WHERE "parentPartnerId" IS NOT NULL;

ALTER TABLE "AffiliateProgram"
  ADD COLUMN IF NOT EXISTS "tier2Enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AffiliateProgram"
  ADD COLUMN IF NOT EXISTS "tier2Percent" NUMERIC NOT NULL DEFAULT 10;

ALTER TABLE "AffiliateProgram" DROP CONSTRAINT IF EXISTS "AffiliateProgram_tier2Percent_check";
ALTER TABLE "AffiliateProgram" ADD CONSTRAINT "AffiliateProgram_tier2Percent_check"
  CHECK ("tier2Percent" >= 0 AND "tier2Percent" <= 50);
