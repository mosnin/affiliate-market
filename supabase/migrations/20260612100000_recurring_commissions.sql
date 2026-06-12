-- Recurring commissions + the seller Stripe bridge.
--
-- Creators earn on every billing period a referred customer pays, for as
-- long as the seller's program allows ("recurringMonths"; null/0 = for the
-- life of the subscription). Payment truth comes from Stripe events:
--   * marketplace subscriptions → invoice.paid on the platform webhook
--   * the seller's own app billing → a per-space bridge endpoint the seller
--     points their Stripe webhooks at ("StripeBridge")
-- Stripe invoice ids make commission writes idempotent across retries.

ALTER TABLE "MarketplaceOrder"
  ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT;
CREATE INDEX IF NOT EXISTS idx_marketplace_order_stripe_subscription
  ON "MarketplaceOrder" ("stripeSubscriptionId")
  WHERE "stripeSubscriptionId" IS NOT NULL;

ALTER TABLE "AffiliateCommission"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'marketplace';
ALTER TABLE "AffiliateCommission"
  ADD COLUMN IF NOT EXISTS "periodNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AffiliateCommission"
  ADD COLUMN IF NOT EXISTS "stripeInvoiceId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliate_commission_stripe_invoice
  ON "AffiliateCommission" ("stripeInvoiceId")
  WHERE "stripeInvoiceId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_affiliate_commission_referral
  ON "AffiliateCommission" ("referralId") WHERE "referralId" IS NOT NULL;

-- One bridge per Space. The endpoint URL carries the bridge id (unguessable);
-- the seller pastes their Stripe webhook signing secret back in (stored
-- encrypted) and every event is signature-verified against it.
CREATE TABLE IF NOT EXISTS "StripeBridge" (
  id                 TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "spaceId"          TEXT        NOT NULL UNIQUE REFERENCES "Space"(id) ON DELETE CASCADE,
  "webhookSecretEnc" TEXT,
  "lastEventAt"      TIMESTAMPTZ,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "StripeBridge" ENABLE ROW LEVEL SECURITY;
