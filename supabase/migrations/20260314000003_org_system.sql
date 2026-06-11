-- ============================================================================
-- Organization System: Companies, Memberships, Invitations
-- ============================================================================
-- Adds:
--   1. User.platformRole (user | admin) — replaces Clerk-metadata-only admin
--   2. Company table
--   3. CompanyMembership table
--   4. Space.companyId (nullable link to Company)
--   5. Invitation table
--
-- All new columns have safe defaults so existing rows are unaffected.
-- ============================================================================

-- 1. Add platform_role to User (defaults 'user' — all existing users safe)
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "platformRole" text NOT NULL DEFAULT 'user'
  CHECK ("platformRole" IN ('user', 'admin'));

-- 2. Company
CREATE TABLE IF NOT EXISTS "Company" (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          text NOT NULL,
  "ownerId"     text NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  "websiteUrl"  text,
  "logoUrl"     text,
  "createdAt"   timestamptz NOT NULL DEFAULT now()
);
-- One company per owner
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_owner  ON "Company"("ownerId");
CREATE INDEX       IF NOT EXISTS idx_company_status  ON "Company"(status);

-- 3. CompanyMembership
CREATE TABLE IF NOT EXISTS "CompanyMembership" (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "companyId"   text NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE,
  "userId"        text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('manager_owner', 'manager_manager', 'seller_member')),
  "invitedById"   text REFERENCES "User"(id) ON DELETE SET NULL,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("companyId", "userId")
);
CREATE INDEX IF NOT EXISTS idx_membership_company ON "CompanyMembership"("companyId");
CREATE INDEX IF NOT EXISTS idx_membership_user      ON "CompanyMembership"("userId");

-- 4. Link Space → Company (nullable — all existing spaces untouched)
ALTER TABLE "Space"
  ADD COLUMN IF NOT EXISTS "companyId" text REFERENCES "Company"(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_space_company ON "Space"("companyId");

-- 5. Invitation
CREATE TABLE IF NOT EXISTS "Invitation" (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "companyId"   text NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE,
  email           text NOT NULL,
  "roleToAssign"  text NOT NULL CHECK ("roleToAssign" IN ('manager_manager', 'seller_member')),
  token           text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'expired', 'cancelled')),
  "expiresAt"     timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  "invitedById"   text REFERENCES "User"(id) ON DELETE SET NULL,
  "createdAt"     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invitation_company ON "Invitation"("companyId");
CREATE INDEX IF NOT EXISTS idx_invitation_email     ON "Invitation"(email);
CREATE INDEX IF NOT EXISTS idx_invitation_token     ON "Invitation"(token);
CREATE INDEX IF NOT EXISTS idx_invitation_status    ON "Invitation"(status);

-- 6. RLS for new tables (defense-in-depth; service role bypasses these)
ALTER TABLE "Company"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CompanyMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invitation"          ENABLE ROW LEVEL SECURITY;
