-- Migration: Add dual form config columns (rental + buyer)
-- Date: 2026-04-08
-- Description: The original form builder assumed one config per space. Now each space
--   needs separate rental and buyer form configs so the "Getting Started" step can
--   route applicants to the correct form. Legacy single `formConfig` column is kept
--   for backwards compatibility and treated as the rental config when present.

-- ============================================================
-- SpaceSetting: per-agent dual form configuration
-- ============================================================

-- Rental-specific form config (replaces the single formConfig for rental path)
ALTER TABLE "SpaceSetting"
  ADD COLUMN IF NOT EXISTS "rentalFormConfig" jsonb DEFAULT NULL;

-- Buyer-specific form config
ALTER TABLE "SpaceSetting"
  ADD COLUMN IF NOT EXISTS "buyerFormConfig" jsonb DEFAULT NULL;

-- ============================================================
-- Company: company-level dual form templates
-- ============================================================

-- Rental-specific company template
ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "companyRentalFormConfig" jsonb DEFAULT NULL;

-- Buyer-specific company template
ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "companyBuyerFormConfig" jsonb DEFAULT NULL;

-- ============================================================
-- Contact: which form path the applicant used
-- ============================================================

-- Stores which lead type path the applicant chose in "Getting Started"
ALTER TABLE "Contact"
  ADD COLUMN IF NOT EXISTS "formLeadType" text DEFAULT NULL
    CHECK ("formLeadType" IN ('rental', 'buyer'));

-- ============================================================
-- Indexes
-- ============================================================

-- GIN indexes on new JSONB columns for containment queries
CREATE INDEX IF NOT EXISTS idx_space_setting_rental_form_config
  ON "SpaceSetting" USING gin("rentalFormConfig") WHERE "rentalFormConfig" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_space_setting_buyer_form_config
  ON "SpaceSetting" USING gin("buyerFormConfig") WHERE "buyerFormConfig" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_company_rental_form_config
  ON "Company" USING gin("companyRentalFormConfig") WHERE "companyRentalFormConfig" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_company_buyer_form_config
  ON "Company" USING gin("companyBuyerFormConfig") WHERE "companyBuyerFormConfig" IS NOT NULL;

-- Index for filtering contacts by form lead type
CREATE INDEX IF NOT EXISTS idx_contact_form_lead_type
  ON "Contact"("formLeadType") WHERE "formLeadType" IS NOT NULL;

-- ============================================================
-- Data migration: copy existing single formConfig to rentalFormConfig
-- ============================================================
-- These backfills READ the legacy single-config columns created by
-- 20260408_add_form_builder.sql (SpaceSetting."formConfig" and
-- Company."companyFormConfig"). Because the 20260408_* filenames carry no
-- time component, Supabase sorts this file BEFORE add_form_builder.sql, so on a
-- FRESH database those source columns do not exist yet when this runs. Guard the
-- backfills behind an existence check so a fresh DB skips them harmlessly (the
-- columns get created later with no rows to backfill), while an upgraded DB that
-- already has the columns runs them exactly as before.

-- SpaceSetting backfill (depends on "SpaceSetting"."formConfig")
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'SpaceSetting' AND column_name = 'formConfig'
  ) THEN
    -- Spaces that already have a custom formConfig with leadType='rental' (or 'general')
    -- should have it copied to rentalFormConfig for seamless migration.
    UPDATE "SpaceSetting"
      SET "rentalFormConfig" = "formConfig"
      WHERE "formConfig" IS NOT NULL
        AND "rentalFormConfig" IS NULL
        AND ("formConfig"->>'leadType' IS NULL
             OR "formConfig"->>'leadType' IN ('rental', 'general'));

    -- Spaces that have a custom formConfig with leadType='buyer'
    -- should have it copied to buyerFormConfig.
    UPDATE "SpaceSetting"
      SET "buyerFormConfig" = "formConfig"
      WHERE "formConfig" IS NOT NULL
        AND "buyerFormConfig" IS NULL
        AND "formConfig"->>'leadType' = 'buyer';
  END IF;
END $$;

-- Company backfill (depends on "Company"."companyFormConfig")
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Company' AND column_name = 'companyFormConfig'
  ) THEN
    UPDATE "Company"
      SET "companyRentalFormConfig" = "companyFormConfig"
      WHERE "companyFormConfig" IS NOT NULL
        AND "companyRentalFormConfig" IS NULL
        AND ("companyFormConfig"->>'leadType' IS NULL
             OR "companyFormConfig"->>'leadType' IN ('rental', 'general'));

    UPDATE "Company"
      SET "companyBuyerFormConfig" = "companyFormConfig"
      WHERE "companyFormConfig" IS NOT NULL
        AND "companyBuyerFormConfig" IS NULL
        AND "companyFormConfig"->>'leadType' = 'buyer';
  END IF;
END $$;
