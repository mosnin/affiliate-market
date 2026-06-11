-- Add privacyPolicyHtml column to SpaceSetting and Company tables
-- Stores rich-text (HTML) privacy policy content

ALTER TABLE "SpaceSetting"
  ADD COLUMN IF NOT EXISTS "privacyPolicyHtml" text;

ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "privacyPolicyHtml" text;
