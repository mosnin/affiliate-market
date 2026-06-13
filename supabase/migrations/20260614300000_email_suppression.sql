-- Email suppression list — the CAN-SPAM / RFC 8058 opt-out backstop.
--
-- Cola sends two recurring marketing emails: the creator weekly digest and the
-- seller weekly digest. Both are now legally required to carry a working
-- unsubscribe. This table records who has opted out of which list. A signed,
-- stateless token in each email's unsubscribe link (lib/email/suppression.ts)
-- carries the recipient + list; hitting /api/unsubscribe inserts the matching
-- row here, and every digest send checks this table first and skips suppressed
-- recipients.
--
-- Transactional emails (commission earned, payout sent, partner approved, order
-- receipt, new-sale, new-affiliate) are NOT subject to this — CAN-SPAM exempts
-- mail about a transaction the recipient initiated — so they never read it.
--
-- "listType" is narrow on purpose: a person who is both a creator and a seller
-- under the same address can leave one list without silencing the other.

-- ── EmailSuppression ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "EmailSuppression" (
  -- ids are TEXT across this schema (gen_random_uuid()::text). No FK: an email
  -- here need not correspond to any User/AffiliatePartner row (creators and
  -- buyers may have no account), so it's keyed by the address itself.
  "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  -- Always written lower-cased by the app (lib/email/suppression.ts normalizes),
  -- so a plain unique index on the raw column is correct and lets PostgREST
  -- upsert with onConflict('email,listType').
  "email"      TEXT NOT NULL,
  "listType"   TEXT NOT NULL
                 CHECK ("listType" IN ('creator_digest', 'seller_digest')),
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One opt-out row per (address, list). Unique so a double-click on the
-- unsubscribe link is idempotent, and so onConflict upsert is race-safe.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_email_suppression_email_list"
  ON "EmailSuppression" ("email", "listType");

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Service-role only (the server). The unsubscribe route runs server-side with
-- the service key, which bypasses RLS; the browser anon key never touches this
-- table. Enable RLS with no policy: deny-all for anon/authenticated.
ALTER TABLE "EmailSuppression" ENABLE ROW LEVEL SECURITY;
