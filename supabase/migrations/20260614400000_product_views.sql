-- Product-view tracking: the top of the seller's funnel.
--
-- The problem: nothing recorded marketplace product-page views, so a seller
-- could see sales but never the views that should have led to them. With no
-- views number there is no funnel — no way to tell a listing that nobody opens
-- from one that everybody opens but nobody buys. Those are opposite problems
-- with opposite fixes (distribution vs. the listing itself), and the seller
-- was blind to which one they had.
--
-- "ProductView" is one append-only row per beaconed page view. It is written
-- only by the server (the public /api/track/product-view endpoint, rate-limited
-- per IP), and read only by the seller funnel. Deliberately thin: no user
-- agent, no referrer, no landing URL — a funnel needs a count, not a session
-- replay. `visitorId` is the anonymous cola_vid cookie so a future "unique
-- views" cut is possible without schema change; we don't dedupe on write
-- (the beacon already fires once per product per session client-side).

-- ── ProductView ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ProductView" (
  -- ids are TEXT across this schema (gen_random_uuid()::text); the productId FK
  -- must match Product.id, which is TEXT — not native UUID.
  "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  -- Denormalised owning space so the funnel can scope by seller without a join
  -- back through Product on every read. Nullable so a view is never lost if the
  -- Product→Space resolution ever comes up empty; the funnel reads by productId.
  "spaceId"    TEXT,
  "productId"  TEXT NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE,
  -- Anonymous cola_vid cookie. Nullable — a view still counts without it.
  "visitorId"  TEXT,
  -- Truncated sha256 of the client IP (write path hashes it). Spam/abuse
  -- forensics only; never used for attribution. Nullable.
  "ipHash"     TEXT,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only read shape: a product's views, optionally windowed by time, and the
-- count aggregate batched across many products on the funnel page.
CREATE INDEX IF NOT EXISTS "idx_productview_product_created"
  ON "ProductView" ("productId", "createdAt" DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- The server talks to Postgres with the service role, which bypasses RLS; the
-- browser anon key never reads "ProductView" directly (writes go through the
-- public tracking endpoint, reads through lib/marketplace/views.ts on the
-- server). Enable RLS with no policy: deny-all for anon/authenticated, the
-- correct closed default. If a client-side read is ever needed, add a scoped
-- SELECT policy in a follow-up — do not weaken this back to open.
ALTER TABLE "ProductView" ENABLE ROW LEVEL SECURITY;
