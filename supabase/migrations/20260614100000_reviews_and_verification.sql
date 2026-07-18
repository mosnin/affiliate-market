-- Marketplace trust & safety: buyer reviews + a verified-listing flag.
--
-- Two problems this closes:
--   1. No buyer reviews → no trust signal and nothing to rank on.
--   2. No listing verification → no guard against scam software.
--
-- A "Review" is written by a buyer who actually purchased the product (the
-- write path enforces a paid MarketplaceOrder before insert). One review per
-- buyer per product, keyed on lower(buyerEmail) so case can't be used to leave
-- duplicates. Reviews default to 'published'; an admin can flip a row to
-- 'hidden' to moderate without deleting the buyer's words.
--
-- "Product.verified" is a platform-admin signal, not a seller one — a seller
-- cannot set it on themselves (the seller product API never writes it; only the
-- admin verify route does). It shows as a badge and is available as a ranking
-- input.

-- ── Review ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Review" (
  -- ids are TEXT across this schema (gen_random_uuid()::text); the FKs must
  -- match Space.id / Product.id, which are TEXT — not native UUID.
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  -- Denormalised owning space so moderation/analytics can scope by seller
  -- without a join back through Product on every read.
  "spaceId"     TEXT NOT NULL REFERENCES "Space"("id") ON DELETE CASCADE,
  "productId"   TEXT NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE,
  "buyerEmail"  TEXT NOT NULL,
  "rating"      INTEGER NOT NULL CHECK ("rating" BETWEEN 1 AND 5),
  "title"       TEXT,
  "body"        TEXT,
  "status"      TEXT NOT NULL DEFAULT 'published'
                  CHECK ("status" IN ('published', 'hidden')),
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One review per buyer per product. lower(buyerEmail) so Foo@x.com and
-- foo@x.com are the same author and can't double-review.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_review_product_buyer"
  ON "Review" ("productId", lower("buyerEmail"));

-- The hot read: a product's published reviews, newest first, and the rating
-- aggregate batched across many products.
CREATE INDEX IF NOT EXISTS "idx_review_product_status"
  ON "Review" ("productId", "status", "createdAt" DESC);

-- ── Product.verified ──────────────────────────────────────────────────────────
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "verified" BOOLEAN NOT NULL DEFAULT false;

-- Surfacing verified, published listings (badge + ranking).
CREATE INDEX IF NOT EXISTS "idx_product_verified"
  ON "Product" ("verified")
  WHERE "published" = true AND "verified" = true;

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- The server talks to Postgres with the service role, which bypasses RLS; the
-- browser anon key never reads "Review" directly (all access goes through the
-- server functions in lib/marketplace/reviews.ts). Enable RLS with no policy:
-- deny-all for anon/authenticated, which is the correct closed default. If a
-- client-side read is ever needed, add a scoped SELECT policy in a follow-up.
ALTER TABLE "Review" ENABLE ROW LEVEL SECURITY;
