-- ═══════════════════════════════════════════════════════════════════════════
-- ProfilePage.profilePhotoUrl — the seller's face on the public /p/[slug]
-- page. Distinct from SpaceSetting.sellerPhotoUrl (used in the dashboard
-- chrome / intake form / booking page) so the seller can pick a
-- public-facing portrait without disturbing the photo their dashboard +
-- internal forms display.
--
-- Stored as a Wasabi object KEY (signed on read, same contract as
-- coverPhotoUrl). Nullable — when null, the public page falls back to
-- the existing chain: sellerPhotoUrl → User.avatar → Clerk imageUrl.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "ProfilePage"
  ADD COLUMN IF NOT EXISTS "profilePhotoUrl" text;
