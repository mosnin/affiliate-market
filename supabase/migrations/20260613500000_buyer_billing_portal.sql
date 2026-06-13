-- Buyer self-service: store the Stripe customer id on subscription orders so
-- the buyer portal can open the Stripe billing portal (update card, cancel,
-- see invoices) without the seller doing support.

ALTER TABLE "MarketplaceOrder"
  ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;
CREATE INDEX IF NOT EXISTS idx_marketplace_order_stripe_customer
  ON "MarketplaceOrder" ("stripeCustomerId")
  WHERE "stripeCustomerId" IS NOT NULL;
