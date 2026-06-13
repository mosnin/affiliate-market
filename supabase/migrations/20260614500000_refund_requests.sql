-- Buyer-initiated refund requests — the missing half of the refund loop.
--
-- The seller can already PROCESS a refund (lib/marketplace/orders.ts
-- markOrderRefunded), but the buyer had no way to ASK for one: the portal only
-- displayed a "Refunded" status. This table is that ask. A buyer who owns a
-- PAID order files a RefundRequest; the seller sees it on their orders page and
-- decides. Approving it is still the seller's existing refund action — this row
-- is the signal, not the money. No money lives here; the net/gross rules don't
-- apply.
--
-- A request can only be created server-side (lib/marketplace/refunds.ts) after
-- verifying the order exists, belongs to the buyer (lower(buyerEmail)), and is
-- 'paid'. spaceId is denormalised off the order so the seller can scope their
-- pending-requests read without a join back through MarketplaceOrder.

-- ── RefundRequest ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RefundRequest" (
  -- ids are TEXT across this schema (gen_random_uuid()::text); the FKs must
  -- match MarketplaceOrder.id / Space.id, which are TEXT — not native UUID.
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "orderId"     TEXT NOT NULL REFERENCES "MarketplaceOrder"("id") ON DELETE CASCADE,
  -- Denormalised owning space so the seller can scope pending requests without
  -- a join back through MarketplaceOrder on every read.
  "spaceId"     TEXT NOT NULL REFERENCES "Space"("id") ON DELETE CASCADE,
  "buyerEmail"  TEXT NOT NULL,
  -- Optional buyer note ("wrong product", "never received the key"). Nullable.
  "reason"      TEXT,
  "status"      TEXT NOT NULL DEFAULT 'requested'
                  CHECK ("status" IN ('requested', 'approved', 'declined')),
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "resolvedAt"  TIMESTAMPTZ
);

-- One OPEN request per order. Partial unique index on orderId WHERE
-- status='requested': a buyer can't spam a second open request, but a declined
-- request doesn't permanently block them from asking again if circumstances
-- change. (A plain UNIQUE(orderId) would lock the order forever after a
-- decline — the partial index is the kinder, equally race-safe choice.)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_refund_request_open_order"
  ON "RefundRequest" ("orderId")
  WHERE "status" = 'requested';

-- The seller's hot read: pending requests for a space, newest first, so the
-- orders page can badge rows and show a count in one query.
CREATE INDEX IF NOT EXISTS "idx_refund_request_space_status"
  ON "RefundRequest" ("spaceId", "status", "createdAt" DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- The server talks to Postgres with the service role, which bypasses RLS; the
-- browser anon key never reads "RefundRequest" directly (all access goes
-- through the server functions in lib/marketplace/refunds.ts). Enable RLS with
-- no policy: deny-all for anon/authenticated, which is the correct closed
-- default. If a client-side read is ever needed, add a scoped SELECT policy in
-- a follow-up.
ALTER TABLE "RefundRequest" ENABLE ROW LEVEL SECURITY;
