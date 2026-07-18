-- Per-product commission overrides: the program is the default, a product
-- can pay differently. Null = inherit the program. Applies to marketplace
-- sales (which map to a Cola product); bridge sales have no Cola product
-- and always use the program default.

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "commissionType" TEXT;
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "commissionValue" NUMERIC;

ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_commissionType_check";
ALTER TABLE "Product" ADD CONSTRAINT "Product_commissionType_check"
  CHECK ("commissionType" IS NULL OR "commissionType" IN ('percent', 'flat'));
