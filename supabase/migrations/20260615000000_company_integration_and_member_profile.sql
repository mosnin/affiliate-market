-- ============================================================================
-- Company-level integrations + per-member manager profile customization.
--
-- Two additive, tiered features for company owners/admins (NOT seller
-- members — that gate is enforced in the API layer via requireManager /
-- canEditSettings, see lib/permissions.ts):
--
--   1. "CompanyIntegrationConnection" — the company analogue of
--      "IntegrationConnection" (20260525000000). Each admin/owner connects
--      their OWN third-party accounts (inbox, calendar, social) AT the
--      company level. Keyed on (companyId, userId, toolkit) so two
--      admins can each connect their own Gmail without colliding. Composio
--      still holds the OAuth tokens; this table holds the pointer + status +
--      audit, exactly like the seller table.
--
--   2. Per-member manager profile fields on "CompanyMembership" — so an
--      owner/admin can present a profile (display name, title, bio, photo,
--      phone) within the company, mirroring the seller profile on
--      SpaceSetting. Per-member (not per-company) because each admin has
--      their own profile; the company's own identity already lives on the
--      "Company" row (name, logoUrl, websiteUrl).
--
-- Additive and idempotent: IF NOT EXISTS, nullable columns, no destructive
-- DDL. Does not touch "IntegrationConnection", "SpaceSetting", or any seller
-- flow.
-- ============================================================================

-- ── 1. Company-level integration connections ──────────────────────────────

CREATE TABLE IF NOT EXISTS "CompanyIntegrationConnection" (
  "id"                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "companyId"          TEXT NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE,
  "userId"               TEXT NOT NULL,                    -- Clerk userId of the admin/owner who connected
  "toolkit"              TEXT NOT NULL,                    -- composio toolkit slug, e.g. 'gmail'
  "composioConnectionId" TEXT NOT NULL,                    -- the connected-account id Composio returns
  "status"               TEXT NOT NULL DEFAULT 'active'
                           CHECK ("status" IN ('active', 'expired', 'revoked', 'failed')),
  "label"                TEXT,                             -- human-readable: 'work@example.com'
  "lastError"            TEXT,                             -- on 'failed' / 'expired'
  "lastUsedAt"           TIMESTAMPTZ,
  "createdAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active connection per (company, userId, toolkit). Disconnect flips
-- the prior row's status to 'revoked' so this partial unique index stays
-- clean — same invariant the seller table holds.
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyIntegrationConnection_active_unique"
  ON "CompanyIntegrationConnection" ("companyId", "userId", "toolkit")
  WHERE "status" = 'active';

CREATE INDEX IF NOT EXISTS "CompanyIntegrationConnection_companyId_idx"
  ON "CompanyIntegrationConnection" ("companyId", "status");

CREATE INDEX IF NOT EXISTS "CompanyIntegrationConnection_userId_idx"
  ON "CompanyIntegrationConnection" ("userId");

ALTER TABLE "CompanyIntegrationConnection" ENABLE ROW LEVEL SECURITY;

-- ── 2. Per-member manager profile fields ─────────────────────────────────────
-- Mirror of the seller profile (SpaceSetting.bio / socialLinks / phoneNumber /
-- businessName / sellerPhotoUrl) but scoped to a single company member.

ALTER TABLE "CompanyMembership" ADD COLUMN IF NOT EXISTS "displayName" TEXT;
ALTER TABLE "CompanyMembership" ADD COLUMN IF NOT EXISTS "title"       TEXT;
ALTER TABLE "CompanyMembership" ADD COLUMN IF NOT EXISTS "bio"         TEXT;
ALTER TABLE "CompanyMembership" ADD COLUMN IF NOT EXISTS "photoUrl"    TEXT;
ALTER TABLE "CompanyMembership" ADD COLUMN IF NOT EXISTS "phone"       TEXT;
