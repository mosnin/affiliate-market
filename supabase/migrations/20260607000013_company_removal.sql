-- CompanyRemoval — deny-list for members who have been removed from a
-- company. Pairs with the /manager/join route's anonymous-code path
-- to prevent a removed agent from silently re-joining via the same
-- invite code that's still circulating in their email.
--
-- Why not soft-delete on CompanyMembership? 38 query sites read
-- that table; adding a `status='active'` predicate to all of them is
-- a big refactor that risks introducing latent bugs. A separate
-- deny-list table is small surface, easy to verify, and only the
-- two routes that care (members/[id] DELETE writes; manager/join
-- POST reads) need to know about it.
--
-- Re-hire path: deliberate. A removed agent can still come back via
-- an explicit manager-issued Invitation (the /api/invitations/[token]
-- POST flow) — that path does NOT consult this table. Anonymous
-- join codes are the one we close off. A manager can also clear an
-- entry from this table to re-allow code-based join if they decide
-- to rescind a removal.

CREATE TABLE IF NOT EXISTS "CompanyRemoval" (
  "companyId" text NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE,
  "userId"      text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "removedAt"   timestamptz NOT NULL DEFAULT now(),
  "removedById" text REFERENCES "User"(id) ON DELETE SET NULL,
  "reason"      text,
  PRIMARY KEY ("companyId", "userId")
);

CREATE INDEX IF NOT EXISTS idx_company_removal_user
  ON "CompanyRemoval" ("userId");

-- RLS: service-role-only writes (server-only flow). No client read paths.
ALTER TABLE "CompanyRemoval" ENABLE ROW LEVEL SECURITY;
