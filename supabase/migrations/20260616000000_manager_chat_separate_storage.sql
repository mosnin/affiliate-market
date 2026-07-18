-- ============================================================================
-- Manager Cola conversations move to their OWN tables (structural isolation).
--
-- THE BUG THIS CLOSES
-- Manager Cola conversations and seller Cola conversations used to live in
-- the SAME "Conversation"/"Message" tables, both keyed by "spaceId" (the manager
-- owner's personal Space). They were distinguished ONLY by a title prefix
-- '[MANAGER_COLA] <companyId>'. That string-prefix boundary leaked
-- company-private data onto the seller dashboard whenever a guard was missed.
-- We eliminate the shared storage: manager conversations get their own tables,
-- keyed by "companyId", so the boundary is STRUCTURAL, not a string match.
--
-- THIS MIGRATION IS ADDITIVE AND IDEMPOTENT.
-- It creates the new tables, then copies the existing manager rows across. It
-- does NOT delete the original "Conversation"/"Message" rows. The seller-side
-- guards (NOT LIKE '[MANAGER_COLA]%') already hide those rows from the seller
-- surfaces, so leaving them in place is harmless and reversible. The destructive
-- purge of the old manager rows is DEFERRED to a separate, later migration, run
-- only after the owner has verified the new tables carry the full history.
--
-- Re-running this migration is safe: CREATE TABLE IF NOT EXISTS for the tables,
-- ON CONFLICT (id) DO NOTHING for every backfilled row.
--
-- Out of scope (still shared storage, migrate next): team chat
-- ('[COMPANY_CHAT]%' in "Conversation"/"Message", app/api/manager/chat/*).
-- ============================================================================

-- ── 1. New tables ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ManagerConversation" (
  "id"          text PRIMARY KEY,
  "companyId" text NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE,
  "title"       text NOT NULL DEFAULT 'New conversation',
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  "updatedAt"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ManagerConversation_companyId_updatedAt_idx"
  ON "ManagerConversation" ("companyId", "updatedAt" DESC);

CREATE TABLE IF NOT EXISTS "ManagerMessage" (
  "id"             text PRIMARY KEY,
  "companyId"    text NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE,
  "conversationId" text NOT NULL REFERENCES "ManagerConversation"(id) ON DELETE CASCADE,
  "role"           text NOT NULL,
  "content"        text NOT NULL DEFAULT '',
  "blocks"         jsonb,
  "createdAt"      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ManagerMessage_conversationId_createdAt_idx"
  ON "ManagerMessage" ("conversationId", "createdAt");

-- ── 2. Backfill conversations (additive, non-destructive) ───────────────────
-- For every existing manager-Cola "Conversation", create a "ManagerConversation"
-- with the SAME id so the URL "?conversationId=" links keep resolving. The
-- companyId is the FIRST whitespace-delimited token AFTER the prefix
-- '[MANAGER_COLA] ' (the title may have extra auto-title text after the id,
-- e.g. '[MANAGER_COLA] brk_123 Pipeline question' — we take only 'brk_123').
-- The JOIN to "Company" guards the FK: a malformed title whose parsed token
-- is not a real company id is simply skipped, so no FK violation is possible.

INSERT INTO "ManagerConversation" ("id", "companyId", "title", "createdAt", "updatedAt")
SELECT
  c."id",
  b."id" AS "companyId",
  c."title",
  c."createdAt",
  c."updatedAt"
FROM "Conversation" c
JOIN "Company" b
  ON b."id" = split_part(substring(c."title" FROM char_length('[MANAGER_COLA] ') + 1), ' ', 1)
WHERE c."title" LIKE '[MANAGER_COLA] %'
ON CONFLICT ("id") DO NOTHING;

-- ── 3. Backfill messages (additive, non-destructive) ────────────────────────
-- Copy every "Message" whose conversation now exists in "ManagerConversation".
-- companyId comes from the matching "ManagerConversation" so it can never
-- disagree with the parent and can never violate the FK.

INSERT INTO "ManagerMessage" ("id", "companyId", "conversationId", "role", "content", "blocks", "createdAt")
SELECT
  m."id",
  bc."companyId",
  m."conversationId",
  m."role",
  m."content",
  m."blocks",
  m."createdAt"
FROM "Message" m
JOIN "ManagerConversation" bc
  ON bc."id" = m."conversationId"
ON CONFLICT ("id") DO NOTHING;

-- NOTE: No DELETE. The original "Conversation"/"Message" manager rows remain in
-- place. The purge is a separate, later migration run after owner verification.
