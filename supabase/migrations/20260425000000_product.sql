-- Phase 9 of the deals redesign: Product as a first-class entity.
--
-- Motivation: Deal.address has always been a string, which means a seller
-- re-types the same product across multiple deals (an original fell
-- through, re-listed; co-listing with another agent; separate buyer +
-- seller engagements on the same house). Having `Product` as a row unlocks:
--   * consistent display of beds/baths/sqft/list-price across cards + docs
--   * listing-packet share links (Phase 11)
--   * buyer wishlist matching (future)
--
-- Design decisions:
--   * `address` stays on Deal as the display string so existing deals are
--     unaffected and sellers can quick-create a deal without going
--     through product creation first.
--   * Deal.productId is nullable. A deal can live without a linked
--     product, or get linked later.
--   * photos stored as a JSONB array of URLs (consistent with existing
--     Contact.products). DealDocuments of kind='photo' are a separate,
--     deal-scoped thing and we don't try to unify them here.
--   * `listingStatus` is free-form-ish (active | pending | sold | off_market
--     | owned) so individual markets can use what fits — checked against a
--     short canonical list to catch typos.

CREATE TABLE IF NOT EXISTS "Product" (
  id              TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "spaceId"       TEXT         NOT NULL REFERENCES "Space"(id) ON DELETE CASCADE,
  address         TEXT         NOT NULL,
  "unitNumber"    TEXT,
  city            TEXT,
  "stateRegion"   TEXT,
  "postalCode"    TEXT,
  "mlsNumber"     TEXT,
  "productType"  TEXT,                           -- 'single_family' | 'condo' | 'townhouse' | 'multi_family' | 'land' | 'other'
  beds            NUMERIC(4,1),
  baths           NUMERIC(4,1),
  "squareFeet"    INTEGER,
  "lotSizeSqft"   INTEGER,
  "yearBuilt"     INTEGER,
  "listPrice"     NUMERIC(14,2),
  "listingStatus" TEXT NOT NULL DEFAULT 'active', -- 'active'|'pending'|'sold'|'off_market'|'owned'
  "listingUrl"    TEXT,                           -- optional link to the MLS / Zillow page
  photos          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- array of URLs
  notes           TEXT,
  "createdAt"     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT "Product_listingStatus_check" CHECK ("listingStatus" IN (
    'active', 'pending', 'sold', 'off_market', 'owned'
  )),
  CONSTRAINT "Product_productType_check" CHECK ("productType" IS NULL OR "productType" IN (
    'single_family', 'condo', 'townhouse', 'multi_family', 'land', 'commercial', 'other'
  ))
);

CREATE INDEX IF NOT EXISTS idx_product_space_updated
  ON "Product" ("spaceId", "updatedAt" DESC);

-- Case-insensitive address search inside a space.
CREATE INDEX IF NOT EXISTS idx_product_space_address
  ON "Product" ("spaceId", lower(address));

-- Unique MLS number per space (soft — a seller working multiple MLSes could
-- still hit collisions; in that case they'll see a 409 and can decide).
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_space_mls
  ON "Product" ("spaceId", "mlsNumber")
  WHERE "mlsNumber" IS NOT NULL;

ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;

-- Link Deal + Demo to Product. Nullable: the entity is optional.
ALTER TABLE "Deal"
  ADD COLUMN IF NOT EXISTS "productId" TEXT REFERENCES "Product"(id) ON DELETE SET NULL;

ALTER TABLE "Demo"
  ADD COLUMN IF NOT EXISTS "productId" TEXT REFERENCES "Product"(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_deal_product ON "Deal" ("productId") WHERE "productId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_demo_product ON "Demo" ("productId") WHERE "productId" IS NOT NULL;
