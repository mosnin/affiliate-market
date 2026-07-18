-- Company product pool.
--
-- Lets a company own products centrally and assign them down to its member
-- sellers (the model chosen for Cola-for-Managers Phase 2).
--
--   * "companyId"     — non-null marks a Product as part of a company pool.
--                         The manager creates it; "spaceId" stays the manager
--                         owner's Space (the pool's home) so the existing NOT
--                         NULL FK on "spaceId" holds without a data backfill.
--   * "assignedSpaceId" — the member seller's Space the product is assigned
--                         to. NULL = unassigned, sitting in the pool. A seller
--                         sees a pool product in their own workspace when
--                         "assignedSpaceId" = their space.
--
-- Additive + idempotent: no existing column is touched, both columns are
-- nullable, and every statement is IF NOT EXISTS. Personal (non-pool)
-- products are unaffected — they keep "companyId" NULL and behave exactly
-- as before.

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "companyId"     TEXT REFERENCES "Company"(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "assignedSpaceId" TEXT REFERENCES "Space"(id)     ON DELETE SET NULL;

-- Pool listing for a company, newest first.
CREATE INDEX IF NOT EXISTS idx_product_company
  ON "Product" ("companyId", "updatedAt" DESC)
  WHERE "companyId" IS NOT NULL;

-- A seller's assigned pool products.
CREATE INDEX IF NOT EXISTS idx_product_assigned_space
  ON "Product" ("assignedSpaceId")
  WHERE "assignedSpaceId" IS NOT NULL;
