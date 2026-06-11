-- Add AI-generated scoring model columns to SpaceSetting and Company
-- These store the scoring models separately from the form configs

-- Space-level scoring models (per agent)
ALTER TABLE "SpaceSetting"
  ADD COLUMN IF NOT EXISTS "rentalScoringModel" jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "buyerScoringModel" jsonb DEFAULT NULL;

-- Company-level scoring models (inherited by members)
ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "companyRentalScoringModel" jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "companyBuyerScoringModel" jsonb DEFAULT NULL;

COMMENT ON COLUMN "SpaceSetting"."rentalScoringModel" IS 'AI-generated scoring model for rental intake form. JSON matches ScoringModel type.';
COMMENT ON COLUMN "SpaceSetting"."buyerScoringModel" IS 'AI-generated scoring model for buyer intake form. JSON matches ScoringModel type.';
COMMENT ON COLUMN "Company"."companyRentalScoringModel" IS 'Company-wide default scoring model for rental forms.';
COMMENT ON COLUMN "Company"."companyBuyerScoringModel" IS 'Company-wide default scoring model for buyer forms.';
