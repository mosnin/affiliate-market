-- Marketplace GMV take: the platform earns a transaction fee on every paid
-- marketplace sale (not just on affiliate commissions). This is the primary
-- monetization of the marketplace itself. Fee comes out of the seller's
-- proceeds; buyer pays the listed price.
--
-- Default rate lives in code (lib/marketplace/fees.ts); a per-space override
-- on Space lets the platform negotiate individual deals. Each order records
-- the fee actually applied, for the operator P&L and audit.

ALTER TABLE "MarketplaceOrder"
  ADD COLUMN IF NOT EXISTS "platformGmvFeeCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Space"
  ADD COLUMN IF NOT EXISTS "marketplaceFeeBps" INTEGER;
