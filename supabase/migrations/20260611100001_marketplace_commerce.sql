-- Marketplace commerce — Product becomes a sellable software listing, plus
-- orders and license delivery.
--
-- The Product table was inherited from the real-estate era (address, beds,
-- baths…). Those columns stay (harmless, unused by new UI) — this migration
-- adds the software-product fields and relaxes the legacy constraints so the
-- new option values ('saas', 'draft' …) are valid.

-- Legacy real-estate checks would reject the new software option values.
ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_productType_check";
ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_listingStatus_check";
ALTER TABLE "Product" ALTER COLUMN address DROP NOT NULL;
ALTER TABLE "Product" ALTER COLUMN "listingStatus" SET DEFAULT 'draft';

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "name"            TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "tagline"         TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "longDescription" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "category"        TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "pricingModel"    TEXT NOT NULL DEFAULT 'one_time';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "priceCents"      INTEGER;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "currency"        TEXT NOT NULL DEFAULT 'usd';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "billingPeriod"   TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "features"        JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "logoUrl"         TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "websiteUrl"      TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "published"       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "marketplaceSlug" TEXT;

-- Older rows used `address` as the display name; backfill so nothing renders blank.
UPDATE "Product" SET "name" = address WHERE "name" IS NULL AND address IS NOT NULL;

ALTER TABLE "Product" ADD CONSTRAINT "Product_pricingModel_check"
  CHECK ("pricingModel" IN ('one_time', 'subscription'));
ALTER TABLE "Product" ADD CONSTRAINT "Product_billingPeriod_check"
  CHECK ("billingPeriod" IS NULL OR "billingPeriod" IN ('monthly', 'yearly'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_marketplace_slug
  ON "Product" ("marketplaceSlug") WHERE "marketplaceSlug" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_published
  ON "Product" ("published", "category") WHERE "published" = true;

CREATE TABLE IF NOT EXISTS "MarketplaceOrder" (
  id                         TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "spaceId"                  TEXT        NOT NULL REFERENCES "Space"(id) ON DELETE CASCADE,
  "productId"                TEXT        NOT NULL REFERENCES "Product"(id) ON DELETE CASCADE,
  "buyerEmail"               TEXT        NOT NULL,
  "clientUserId"             TEXT,
  "amountCents"              INTEGER     NOT NULL DEFAULT 0,
  currency                   TEXT        NOT NULL DEFAULT 'usd',
  status                     TEXT        NOT NULL DEFAULT 'pending',
  "referralCode"             TEXT,
  "stripeCheckoutSessionId"  TEXT,
  "createdAt"                TIMESTAMPTZ NOT NULL DEFAULT now(),
  "paidAt"                   TIMESTAMPTZ,

  CONSTRAINT "MarketplaceOrder_status_check"
    CHECK (status IN ('pending', 'paid', 'refunded', 'canceled'))
);

CREATE INDEX IF NOT EXISTS idx_marketplace_order_space_created
  ON "MarketplaceOrder" ("spaceId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_buyer
  ON "MarketplaceOrder" (lower("buyerEmail"));
CREATE INDEX IF NOT EXISTS idx_marketplace_order_stripe_session
  ON "MarketplaceOrder" ("stripeCheckoutSessionId")
  WHERE "stripeCheckoutSessionId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "License" (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "orderId"     TEXT        NOT NULL REFERENCES "MarketplaceOrder"(id) ON DELETE CASCADE,
  "productId"   TEXT        NOT NULL REFERENCES "Product"(id) ON DELETE CASCADE,
  "buyerEmail"  TEXT        NOT NULL,
  "licenseKey"  TEXT        NOT NULL UNIQUE,
  status        TEXT        NOT NULL DEFAULT 'active',
  "deliveredAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expiresAt"   TIMESTAMPTZ,

  CONSTRAINT "License_status_check" CHECK (status IN ('active', 'revoked', 'expired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_license_order ON "License" ("orderId");
CREATE INDEX IF NOT EXISTS idx_license_buyer ON "License" (lower("buyerEmail"));

ALTER TABLE "MarketplaceOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "License"          ENABLE ROW LEVEL SECURITY;
