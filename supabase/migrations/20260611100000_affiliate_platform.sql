-- Native affiliate platform — Cola's built-in replacement for FirstPromoter.
--
-- One default program per Space (more can be added later), partners join via
-- the public /affiliate portal, every partner gets referral links with short
-- codes, clicks are logged for attribution, paid marketplace orders convert
-- into referrals + commissions, and approved commissions accrue into payouts.
--
-- Money is integer cents everywhere ("amountCents") — no floats.

CREATE TABLE IF NOT EXISTS "AffiliateProgram" (
  id                       TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "spaceId"                TEXT        NOT NULL REFERENCES "Space"(id) ON DELETE CASCADE,
  name                     TEXT        NOT NULL DEFAULT 'Default program',
  "commissionType"         TEXT        NOT NULL DEFAULT 'percent',
  "commissionValue"        NUMERIC     NOT NULL DEFAULT 20,
  "recurring"              BOOLEAN     NOT NULL DEFAULT false,
  "recurringMonths"        INTEGER,
  "cookieWindowDays"       INTEGER     NOT NULL DEFAULT 30,
  "autoApproveAffiliates"  BOOLEAN     NOT NULL DEFAULT false,
  "autoApproveCommissions" BOOLEAN     NOT NULL DEFAULT false,
  "createdAt"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "AffiliateProgram_commissionType_check"
    CHECK ("commissionType" IN ('percent', 'flat')),
  CONSTRAINT "AffiliateProgram_commissionValue_check"
    CHECK ("commissionValue" >= 0)
);

CREATE INDEX IF NOT EXISTS idx_affiliate_program_space
  ON "AffiliateProgram" ("spaceId");

CREATE TABLE IF NOT EXISTS "AffiliatePartner" (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "spaceId"       TEXT        NOT NULL REFERENCES "Space"(id) ON DELETE CASCADE,
  "programId"     TEXT        NOT NULL REFERENCES "AffiliateProgram"(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  email           TEXT        NOT NULL,
  "clerkUserId"   TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending',
  "payoutMethod"  TEXT,
  "payoutDetails" JSONB,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "AffiliatePartner_status_check"
    CHECK (status IN ('pending', 'approved', 'suspended'))
);

-- A person joins a given seller's program once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliate_partner_space_email
  ON "AffiliatePartner" ("spaceId", lower(email));
CREATE INDEX IF NOT EXISTS idx_affiliate_partner_clerk
  ON "AffiliatePartner" ("clerkUserId") WHERE "clerkUserId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_affiliate_partner_email
  ON "AffiliatePartner" (lower(email));

CREATE TABLE IF NOT EXISTS "ReferralLink" (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "partnerId"      TEXT        NOT NULL REFERENCES "AffiliatePartner"(id) ON DELETE CASCADE,
  "programId"      TEXT        NOT NULL REFERENCES "AffiliateProgram"(id) ON DELETE CASCADE,
  code             TEXT        NOT NULL UNIQUE,
  "destinationUrl" TEXT,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_link_partner
  ON "ReferralLink" ("partnerId");

CREATE TABLE IF NOT EXISTS "ReferralClick" (
  id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "linkId"     TEXT        NOT NULL REFERENCES "ReferralLink"(id) ON DELETE CASCADE,
  "visitorId"  TEXT,
  "ipHash"     TEXT,
  "userAgent"  TEXT,
  "landingUrl" TEXT,
  referrer     TEXT,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_click_link_created
  ON "ReferralClick" ("linkId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS "Referral" (
  id             TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "linkId"       TEXT        NOT NULL REFERENCES "ReferralLink"(id) ON DELETE CASCADE,
  "partnerId"    TEXT        NOT NULL REFERENCES "AffiliatePartner"(id) ON DELETE CASCADE,
  "buyerEmail"   TEXT        NOT NULL,
  "orderId"      TEXT,
  status         TEXT        NOT NULL DEFAULT 'lead',
  "firstClickAt" TIMESTAMPTZ,
  "convertedAt"  TIMESTAMPTZ,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "Referral_status_check" CHECK (status IN ('lead', 'customer'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_link_buyer
  ON "Referral" ("linkId", lower("buyerEmail"));
CREATE INDEX IF NOT EXISTS idx_referral_partner
  ON "Referral" ("partnerId");

CREATE TABLE IF NOT EXISTS "AffiliateCommission" (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "spaceId"     TEXT        NOT NULL REFERENCES "Space"(id) ON DELETE CASCADE,
  "partnerId"   TEXT        NOT NULL REFERENCES "AffiliatePartner"(id) ON DELETE CASCADE,
  "referralId"  TEXT        REFERENCES "Referral"(id) ON DELETE SET NULL,
  "orderId"     TEXT,
  "amountCents" INTEGER     NOT NULL DEFAULT 0,
  currency      TEXT        NOT NULL DEFAULT 'usd',
  status        TEXT        NOT NULL DEFAULT 'pending',
  level         INTEGER     NOT NULL DEFAULT 1,
  "payoutId"    TEXT,
  note          TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "approvedAt"  TIMESTAMPTZ,

  CONSTRAINT "AffiliateCommission_status_check"
    CHECK (status IN ('pending', 'approved', 'paid', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_affiliate_commission_space_status
  ON "AffiliateCommission" ("spaceId", status, "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_commission_partner_status
  ON "AffiliateCommission" ("partnerId", status);

CREATE TABLE IF NOT EXISTS "AffiliatePayout" (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "spaceId"     TEXT        NOT NULL REFERENCES "Space"(id) ON DELETE CASCADE,
  "partnerId"   TEXT        NOT NULL REFERENCES "AffiliatePartner"(id) ON DELETE CASCADE,
  "amountCents" INTEGER     NOT NULL DEFAULT 0,
  method        TEXT,
  status        TEXT        NOT NULL DEFAULT 'pending',
  "periodStart" TIMESTAMPTZ,
  "periodEnd"   TIMESTAMPTZ,
  "paidAt"      TIMESTAMPTZ,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "AffiliatePayout_status_check"
    CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_affiliate_payout_space
  ON "AffiliatePayout" ("spaceId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_payout_partner
  ON "AffiliatePayout" ("partnerId", "createdAt" DESC);

ALTER TABLE "AffiliateProgram"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliatePartner"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReferralLink"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReferralClick"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Referral"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliateCommission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliatePayout"     ENABLE ROW LEVEL SECURITY;
