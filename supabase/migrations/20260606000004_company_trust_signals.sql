-- Company-level trust signals: optional compliance slots set once by a
-- company admin and inherited by every linked space's /apply/b/[id] intake.
-- Per-space SpaceSetting values take a back seat to these when the intake
-- is served via the company variant — company policy beats per-agent
-- copy for legal text.
--
--   companyLicenseNumber       — company-level real-estate license #
--   companyFairHousingNotice   — multi-line Fair Housing statement
--   companyShowEqualHousingMark — render the Equal Housing Opportunity logo

ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "companyLicenseNumber" text,
  ADD COLUMN IF NOT EXISTS "companyFairHousingNotice" text,
  ADD COLUMN IF NOT EXISTS "companyShowEqualHousingMark" boolean NOT NULL DEFAULT false;
