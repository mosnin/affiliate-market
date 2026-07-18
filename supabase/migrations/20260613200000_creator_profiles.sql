-- Creator profiles + the seller→creator side of the marketplace.
--
-- A creator's identity spans every program they join (one AffiliatePartner
-- row per program, but one person). CreatorProfile is keyed by email — the
-- stable identity getPartnersByUser already aggregates on — and carries the
-- audience facts sellers shop on: reach, channels, niche.
--
-- It's populated opt-in (at join, or from the creator's profile page) and
-- read by the seller creator directory. A creator with no profile still
-- works; they just don't surface in discovery until they fill it in.

CREATE TABLE IF NOT EXISTS "CreatorProfile" (
  id             TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "emailLower"   TEXT        NOT NULL UNIQUE,
  name           TEXT        NOT NULL,
  "clerkUserId"  TEXT,
  bio            TEXT,
  niche          TEXT,
  "audienceSize" INTEGER     NOT NULL DEFAULT 0,
  channels       JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- ['youtube','tiktok','newsletter',...]
  "websiteUrl"   TEXT,
  "avatarUrl"    TEXT,
  -- Discoverable in the seller directory. Off until the creator opts in.
  listed         BOOLEAN     NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creator_profile_listed
  ON "CreatorProfile" ("audienceSize" DESC) WHERE listed = true;
CREATE INDEX IF NOT EXISTS idx_creator_profile_clerk
  ON "CreatorProfile" ("clerkUserId") WHERE "clerkUserId" IS NOT NULL;

-- Seller-initiated partners (directory "invite") vs creator-initiated (join).
ALTER TABLE "AffiliatePartner"
  ADD COLUMN IF NOT EXISTS "invitedBySeller" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CreatorProfile" ENABLE ROW LEVEL SECURITY;
