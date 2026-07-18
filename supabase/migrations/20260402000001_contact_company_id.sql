-- Add companyId to Contact so company intake leads are queryable by company
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "companyId" text REFERENCES "Company"(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contact_company ON "Contact"("companyId");
