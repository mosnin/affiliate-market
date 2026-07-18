-- Marketplace curation: featured listings surface first; category landing
-- pages get SEO-friendly URLs. `featured` is a curation signal that boosts a
-- product's ordering and shows a badge.

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "featured" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_product_featured
  ON "Product" ("featured", "updatedAt" DESC)
  WHERE "published" = true AND "featured" = true;
