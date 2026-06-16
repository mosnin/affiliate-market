-- ============================================================================
-- supabase/schema.current.sql
-- ============================================================================
-- GENERATED FILE — DO NOT EDIT BY HAND.
--
-- This is the AUTHORITATIVE, materialized current shape of every database
-- table. It was produced by booting a fresh PostgreSQL 16 cluster, applying
-- supabase/schema.sql, then applying every supabase/migrations/*.sql file in
-- ascending (timestamp) filename order, and finally introspecting the live
-- database with:
--     pg_dump --schema-only --no-owner --no-privileges --schema=public
--
-- It therefore reflects the FINAL shape of all tables after schema.sql plus all
-- 180 migrations (CREATE TABLE + every ALTER TABLE / ADD COLUMN). The scattered
-- definitions in schema.sql and the migration files remain the change history;
-- THIS file is the single source of truth for the current schema and the basis
-- for the Supabase -> Convex migration.
--
-- Scope note: only the `public` schema is included. Supabase-managed objects
-- (auth/storage schemas, the `anon`/`authenticated`/`service_role` roles, the
-- `supabase_realtime` publication, and RLS GRANT/POLICY statements that depend
-- on them) are intentionally NOT part of this file — they do not define table
-- shape and do not exist in the target Convex model.
--
-- Table count: 116
-- ============================================================================

--
-- PostgreSQL database dump
--

\restrict EGFHDQhj1HKfW8GsxteHye0IXbY9smqwCGPTszLR0xruEXtM23iMmYiBhIPcHhI

-- Dumped from database version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: book_demo_atomic(text, text, text, text, text, text, text, text, timestamp with time zone, timestamp with time zone, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.book_demo_atomic(p_id text, p_space_id text, p_contact_id text, p_guest_name text, p_guest_email text, p_guest_phone text, p_product_address text, p_notes text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_product_profile_id text, p_manage_token text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_conflict_count INT;
BEGIN
  -- Lock existing overlapping demos to prevent concurrent inserts
  PERFORM id FROM "Demo"
    WHERE "spaceId" = p_space_id
      AND status IN ('scheduled', 'confirmed')
      AND "startsAt" < p_ends_at
      AND "endsAt" > p_starts_at
    FOR UPDATE;

  -- Count conflicts (after acquiring lock)
  SELECT COUNT(*) INTO v_conflict_count
    FROM "Demo"
    WHERE "spaceId" = p_space_id
      AND status IN ('scheduled', 'confirmed')
      AND "startsAt" < p_ends_at
      AND "endsAt" > p_starts_at;

  IF v_conflict_count > 0 THEN
    RETURN NULL;  -- Conflict found; caller should return 409
  END IF;

  INSERT INTO "Demo" (
    id, "spaceId", "contactId", "guestName", "guestEmail", "guestPhone",
    "productAddress", notes, "startsAt", "endsAt", "productProfileId", "manageToken"
  ) VALUES (
    p_id, p_space_id, p_contact_id, p_guest_name, p_guest_email, p_guest_phone,
    p_product_address, p_notes, p_starts_at, p_ends_at, p_product_profile_id, p_manage_token
  );

  RETURN p_id;
END;
$$;


--
-- Name: charge_credits_for_chat_usage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.charge_credits_for_chat_usage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_credits integer;
  v_acct    RECORD;
  v_need    integer;
  v_lot     RECORD;
  v_take    integer;
  v_debited integer := 0;
BEGIN
  -- Model-aware cost -> credits. 0.013 USD COGS budget per credit (lib/plans.ts).
  v_credits := GREATEST(1, CEIL(COALESCE(NEW."costUsd", 0) / 0.013));

  SELECT account_type, account_id INTO v_acct
    FROM resolve_billing_account_for_space(NEW."spaceId");
  IF v_acct.account_id IS NULL THEN RETURN NEW; END IF;

  v_need := v_credits;
  -- FIFO drain over spendable lots, soonest-expiring first (nulls last) — mirrors
  -- spend_credits' ordering. Drains to AVAILABLE only (never negative): a turn
  -- that overshoots the balance leaves it at 0 and the app gate refuses the next
  -- one. No spendable lots → no-op (self-gating).
  FOR v_lot IN
    SELECT id, remaining FROM "CreditLot"
     WHERE "accountType" = v_acct.account_type
       AND "accountId"   = v_acct.account_id
       AND remaining > 0
       AND ("expiresAt" IS NULL OR "expiresAt" > now())
     ORDER BY ("expiresAt" IS NULL), "expiresAt" ASC, "createdAt" ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_need <= 0;
    v_take := LEAST(v_lot.remaining, v_need);
    UPDATE "CreditLot" SET remaining = remaining - v_take WHERE id = v_lot.id;
    v_need    := v_need - v_take;
    v_debited := v_debited + v_take;
  END LOOP;

  IF v_debited > 0 THEN
    INSERT INTO "CreditTxn" ("accountType", "accountId", delta, workflow, "spaceId", "userId", reason, metadata)
    VALUES (
      v_acct.account_type, v_acct.account_id, -v_debited, 'chat_turn', NEW."spaceId", NEW."userId", 'spend',
      jsonb_build_object(
        'chatUsageId', NEW.id, 'model', NEW.model, 'costUsd', NEW."costUsd",
        'creditsAssessed', v_credits, 'creditsDebited', v_debited
      )
    );
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: cleanup_agent_data(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_agent_data() RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  deleted_steps     int;
  deleted_tasks     int;
  deleted_memories  int;
  deleted_versions  int;
  deleted_artifacts int;
BEGIN
  -- ── ExecutionStep: rows whose task started > 30 days ago ─────────────────
  -- Uses startedAt as the age signal; falls back to createdAt when startedAt
  -- is NULL (queued steps on a task that never ran).
  DELETE FROM "ExecutionStep"
  WHERE id IN (
    SELECT id FROM "ExecutionStep"
    WHERE COALESCE("startedAt", "createdAt") < NOW() - INTERVAL '30 days'
    LIMIT 1000
  );
  GET DIAGNOSTICS deleted_steps = ROW_COUNT;

  -- ── AgentTask: terminal tasks older than 90 days ──────────────────────────
  -- Only touches completed / failed / cancelled rows so in-flight tasks are
  -- never accidentally deleted. Sub-task children have parentTaskId set to
  -- NULL on parent deletion (ON DELETE SET NULL) and will be swept on a
  -- subsequent invocation once they themselves age out.
  DELETE FROM "AgentTask"
  WHERE id IN (
    SELECT id FROM "AgentTask"
    WHERE status IN ('completed', 'failed', 'cancelled')
      AND "createdAt" < NOW() - INTERVAL '90 days'
    LIMIT 1000
  );
  GET DIAGNOSTICS deleted_tasks = ROW_COUNT;

  -- ── AgentMemory: explicitly expired rows ─────────────────────────────────
  -- The Python prune_expired() RPC already handles this path; this function
  -- ensures cleanup happens even when the Python worker is not running.
  DELETE FROM "AgentMemory"
  WHERE id IN (
    SELECT id FROM "AgentMemory"
    WHERE "expiresAt" IS NOT NULL
      AND "expiresAt" < NOW()
    LIMIT 1000
  );
  GET DIAGNOSTICS deleted_memories = ROW_COUNT;

  -- ── ArtifactVersion: versions tied to old tasks ───────────────────────────
  -- Must precede Artifact deletion: Artifact.currentVersionId FK is deferrable
  -- but we clear versions first to keep the cascade clean.
  DELETE FROM "ArtifactVersion"
  WHERE id IN (
    SELECT av.id
    FROM "ArtifactVersion" av
    JOIN "Artifact"  a  ON av."artifactId" = a.id
    JOIN "AgentTask" at ON a."taskId"      = at.id
    WHERE at."createdAt" < NOW() - INTERVAL '90 days'
    LIMIT 1000
  );
  GET DIAGNOSTICS deleted_versions = ROW_COUNT;

  -- ── Artifact: orphaned by old tasks ──────────────────────────────────────
  -- taskId is SET NULL on AgentTask deletion, so this join only catches
  -- artifacts whose parent task still exists but is aged out. Artifacts
  -- whose parent was already deleted (taskId IS NULL) are out of scope —
  -- they require a separate age-column policy and are intentionally skipped.
  DELETE FROM "Artifact"
  WHERE id IN (
    SELECT a.id
    FROM "Artifact"  a
    JOIN "AgentTask" at ON a."taskId" = at.id
    WHERE at."createdAt" < NOW() - INTERVAL '90 days'
    LIMIT 1000
  );
  GET DIAGNOSTICS deleted_artifacts = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted_steps',             deleted_steps,
    'deleted_tasks',             deleted_tasks,
    'deleted_memories',          deleted_memories,
    'deleted_artifact_versions', deleted_versions,
    'deleted_artifacts',         deleted_artifacts,
    'ran_at',                    NOW()
  );
END;
$$;


--
-- Name: create_company_with_owner(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_company_with_owner(p_name text, p_owner_id text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_company_id TEXT;
BEGIN
  INSERT INTO "Company" (name, "ownerId")
    VALUES (p_name, p_owner_id)
    RETURNING id INTO v_company_id;

  INSERT INTO "CompanyMembership" ("companyId", "userId", role)
    VALUES (v_company_id, p_owner_id, 'manager_owner');

  RETURN v_company_id;
END;
$$;


--
-- Name: create_company_with_owner(text, text, text, text, text, text, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_company_with_owner(p_name text, p_owner_id text, p_logo_url text DEFAULT NULL::text, p_website_url text DEFAULT NULL::text, p_office_address text DEFAULT NULL::text, p_office_phone text DEFAULT NULL::text, p_agent_count text DEFAULT NULL::text, p_company_type text DEFAULT NULL::text, p_primary_market text DEFAULT NULL::text, p_commission_structure text DEFAULT NULL::text, p_geographic_coverage text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_company_id TEXT;
BEGIN
  INSERT INTO "Company" (
    name, "ownerId", "logoUrl", "websiteUrl",
    "officeAddress", "officePhone", "agentCount",
    "companyType", "primaryMarket", "commissionStructure",
    "geographicCoverage"
  ) VALUES (
    p_name, p_owner_id, p_logo_url, p_website_url,
    p_office_address, p_office_phone, p_agent_count,
    p_company_type, p_primary_market, p_commission_structure,
    p_geographic_coverage
  )
  RETURNING id INTO v_company_id;

  INSERT INTO "CompanyMembership" ("companyId", "userId", role)
    VALUES (v_company_id, p_owner_id, 'manager_owner');

  RETURN v_company_id;
END;
$$;


--
-- Name: create_space_with_defaults(text, text, text, text, text, text, text, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_space_with_defaults(p_space_id text, p_slug text, p_name text, p_emoji text, p_owner_id text, p_settings_id text, p_intake_title text, p_intake_intro text, p_business_name text, p_stages jsonb) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_stage JSONB;
BEGIN
  -- Insert space
  INSERT INTO "Space" (id, slug, name, emoji, "ownerId")
    VALUES (p_space_id, p_slug, p_name, p_emoji, p_owner_id);

  -- Insert settings
  INSERT INTO "SpaceSetting" (id, "spaceId", "intakePageTitle", "intakePageIntro", "businessName", "phoneNumber")
    VALUES (p_settings_id, p_space_id, p_intake_title, p_intake_intro, p_business_name, NULL);

  -- Insert default stages
  FOR v_stage IN SELECT * FROM jsonb_array_elements(p_stages)
  LOOP
    INSERT INTO "DealStage" (id, "spaceId", name, color, position)
      VALUES (
        v_stage->>'id',
        p_space_id,
        v_stage->>'name',
        v_stage->>'color',
        (v_stage->>'position')::INT
      );
  END LOOP;

  RETURN p_space_id;
END;
$$;


--
-- Name: current_user_internal_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_user_internal_id() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT id FROM "User" WHERE "clerkId" = auth.uid()::text LIMIT 1
$$;


--
-- Name: ensure_agent_settings_for_space(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_agent_settings_for_space() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO "AgentSettings" ("spaceId")
  VALUES (NEW.id)
  ON CONFLICT ("spaceId") DO NOTHING;
  RETURN NEW;
END;
$$;


--
-- Name: grant_credits(text, text, integer, text, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.grant_credits(p_account_type text, p_account_id text, p_amount integer, p_reason text, p_expires_at timestamp with time zone, p_source_id text DEFAULT NULL::text) RETURNS void
    LANGUAGE sql
    AS $$
  INSERT INTO "CreditLot" ("accountType", "accountId", amount, remaining, reason, "expiresAt", "sourceId")
  VALUES (p_account_type, p_account_id, p_amount, p_amount, p_reason, p_expires_at, p_source_id)
  ON CONFLICT (reason, "sourceId") WHERE "sourceId" IS NOT NULL DO NOTHING;
$$;


--
-- Name: match_agent_memory(public.vector, text, integer, text, text, text, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_agent_memory(query_embedding public.vector, match_space_id text, match_count integer DEFAULT 6, filter_memory_type text DEFAULT NULL::text, filter_entity_type text DEFAULT NULL::text, filter_entity_id text DEFAULT NULL::text, min_similarity double precision DEFAULT 0.0) RETURNS TABLE(id text, content text, "memoryType" text, "entityType" text, "entityId" text, importance double precision, similarity double precision, "createdAt" timestamp with time zone)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m."memoryType",
    m."entityType",
    m."entityId",
    m.importance,
    (1 - (m.embedding <=> query_embedding))::float AS similarity,
    m."createdAt"
  FROM "AgentMemory" m
  WHERE m."spaceId" = match_space_id
    AND m.embedding IS NOT NULL
    AND (filter_memory_type IS NULL OR m."memoryType" = filter_memory_type)
    AND (filter_entity_type IS NULL OR m."entityType" = filter_entity_type)
    AND (filter_entity_id   IS NULL OR m."entityId"   = filter_entity_id)
    AND (1 - (m.embedding <=> query_embedding)) >= min_similarity
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


--
-- Name: match_documents(public.vector, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_documents(query_embedding public.vector, match_space_id text, match_count integer DEFAULT 5) RETURNS TABLE(id text, entity_type text, entity_id text, content text, similarity double precision)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    de.id,
    de."entityType"  AS entity_type,
    de."entityId"    AS entity_id,
    de.content,
    1 - (de.embedding <=> query_embedding) AS similarity
  FROM "DocumentEmbedding" de
  WHERE de."spaceId" = match_space_id
    AND de.embedding IS NOT NULL
  ORDER BY de.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


--
-- Name: match_documents_hybrid(public.vector, text, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_documents_hybrid(query_embedding public.vector, query_text text, match_space_id text, match_count integer DEFAULT 5, rrf_k integer DEFAULT 60) RETURNS TABLE(id text, entity_type text, entity_id text, content text, score double precision)
    LANGUAGE plpgsql
    AS $$
DECLARE
  ts_query tsquery;
BEGIN
  -- plainto_tsquery handles user input safely (no need to escape operators).
  -- Returns null if the text strips to nothing after stop-word removal;
  -- the BM25 leg then yields zero rows and the result reduces to cosine.
  IF query_text IS NOT NULL AND length(trim(query_text)) > 0 THEN
    ts_query := plainto_tsquery('english', query_text);
  ELSE
    ts_query := NULL;
  END IF;

  RETURN QUERY
  WITH cosine_results AS (
    SELECT
      de.id,
      ROW_NUMBER() OVER (ORDER BY de.embedding <=> query_embedding) AS rank
    FROM "DocumentEmbedding" de
    WHERE de."spaceId" = match_space_id
      AND de.embedding IS NOT NULL
    ORDER BY de.embedding <=> query_embedding
    LIMIT match_count * 4
  ),
  bm25_results AS (
    SELECT
      de.id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(de.tsv, ts_query) DESC
      ) AS rank
    FROM "DocumentEmbedding" de
    WHERE de."spaceId" = match_space_id
      AND ts_query IS NOT NULL
      AND de.tsv @@ ts_query
    ORDER BY ts_rank_cd(de.tsv, ts_query) DESC
    LIMIT match_count * 4
  ),
  fused AS (
    SELECT
      COALESCE(c.id, b.id) AS id,
      (CASE WHEN c.rank IS NOT NULL THEN 1.0 / (rrf_k + c.rank) ELSE 0 END) +
      (CASE WHEN b.rank IS NOT NULL THEN 1.0 / (rrf_k + b.rank) ELSE 0 END) AS score
    FROM cosine_results c
    FULL OUTER JOIN bm25_results b ON c.id = b.id
  )
  SELECT
    de.id,
    de."entityType"  AS entity_type,
    de."entityId"    AS entity_id,
    de.content,
    f.score::float
  FROM fused f
  JOIN "DocumentEmbedding" de ON de.id = f.id
  WHERE f.score > 0
  ORDER BY f.score DESC
  LIMIT match_count;
END;
$$;


--
-- Name: offboard_company_member(text, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.offboard_company_member(p_leaving_user_id text, p_destination_user_id text, p_company_id text, p_dry_run boolean DEFAULT false) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_leaving_space_id     text;
  v_destination_space_id text;
  v_destination_status   text;
  v_contact_count        integer := 0;
  v_deal_count           integer := 0;
  v_demo_count           integer := 0;
BEGIN
  -- Destination must still be 'active' — we accept the column not existing
  -- on pre-migration databases by treating NULL as active for forward-compat.
  SELECT COALESCE(status, 'active')
    INTO v_destination_status
    FROM "User"
   WHERE id = p_destination_user_id;
  IF v_destination_status IS NULL THEN
    RAISE EXCEPTION 'Destination user % not found', p_destination_user_id;
  END IF;
  IF v_destination_status <> 'active' THEN
    RAISE EXCEPTION 'Destination user % is not active (status=%)',
      p_destination_user_id, v_destination_status;
  END IF;

  -- Lock both spaces FOR UPDATE early so transfer counts match writes.
  SELECT id INTO v_leaving_space_id
    FROM "Space"
   WHERE "ownerId" = p_leaving_user_id
   FOR UPDATE;
  IF v_leaving_space_id IS NULL THEN
    RAISE EXCEPTION 'Leaving user % has no Space', p_leaving_user_id;
  END IF;

  SELECT id INTO v_destination_space_id
    FROM "Space"
   WHERE "ownerId" = p_destination_user_id
   FOR UPDATE;
  IF v_destination_space_id IS NULL THEN
    RAISE EXCEPTION 'Destination user % has no Space', p_destination_user_id;
  END IF;

  IF v_leaving_space_id = v_destination_space_id THEN
    RAISE EXCEPTION 'Leaving and destination resolve to the same Space';
  END IF;

  -- Stash the id sets for the transfer so count queries match the UPDATEs.
  CREATE TEMP TABLE IF NOT EXISTS _moved_contacts (id text PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _moved_deals    (id text PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE _moved_contacts;
  TRUNCATE _moved_deals;

  INSERT INTO _moved_contacts (id)
  SELECT id FROM "Contact"
   WHERE "spaceId" = v_leaving_space_id
     AND "companyId" = p_company_id;

  INSERT INTO _moved_deals (id)
  SELECT d.id
    FROM "Deal" d
   WHERE d."spaceId" = v_leaving_space_id
     AND EXISTS (
       SELECT 1 FROM "DealContact" dc
       WHERE dc."dealId" = d.id
         AND dc."contactId" IN (SELECT id FROM _moved_contacts)
     );

  SELECT count(*) INTO v_contact_count FROM _moved_contacts;
  SELECT count(*) INTO v_deal_count    FROM _moved_deals;
  SELECT count(*) INTO v_demo_count
    FROM "Demo" t
   WHERE t."spaceId" = v_leaving_space_id
     AND t."contactId" IN (SELECT id FROM _moved_contacts)
     AND t."startsAt" >= now();

  IF p_dry_run THEN
    RETURN json_build_object(
      'dryRun', true,
      'contactCount', v_contact_count,
      'dealCount', v_deal_count,
      'openDemoCount', v_demo_count
    );
  END IF;

  -- Real-run transfer. Explicit spaceId filters added per audit NIT #5 —
  -- belt-and-suspenders over the transitive scoping through _moved_contacts
  -- / _moved_deals. Future refactors won't accidentally widen the scope.
  UPDATE "Contact"
     SET "spaceId" = v_destination_space_id
   WHERE id IN (SELECT id FROM _moved_contacts);

  UPDATE "ContactActivity"
     SET "spaceId" = v_destination_space_id
   WHERE "spaceId" = v_leaving_space_id
     AND "contactId" IN (SELECT id FROM _moved_contacts);

  UPDATE "Deal"
     SET "spaceId" = v_destination_space_id
   WHERE id IN (SELECT id FROM _moved_deals);

  UPDATE "DealActivity"
     SET "spaceId" = v_destination_space_id
   WHERE "spaceId" = v_leaving_space_id
     AND "dealId" IN (SELECT id FROM _moved_deals);

  UPDATE "DealChecklistItem"
     SET "spaceId" = v_destination_space_id
   WHERE "spaceId" = v_leaving_space_id
     AND "dealId" IN (SELECT id FROM _moved_deals);

  UPDATE "Demo"
     SET "spaceId" = v_destination_space_id
   WHERE "spaceId" = v_leaving_space_id
     AND "contactId" IN (SELECT id FROM _moved_contacts);

  DELETE FROM "CompanyMembership"
   WHERE "userId" = p_leaving_user_id
     AND "companyId" = p_company_id;

  -- Only flip User.status to 'offboarded' if this was the user's LAST
  -- company membership. Dual-company sellers (members of two
  -- companies at once) leaving one shouldn't be locked out of Cola
  -- entirely — the API gate in lib/api-auth.ts treats 'offboarded' as
  -- a hard account stop. We still record offboardedAt + offboardedToUserId
  -- so the audit trail for THIS transfer survives, but leave status active
  -- so their other company's membership keeps working.
  IF NOT EXISTS (
    SELECT 1 FROM "CompanyMembership" WHERE "userId" = p_leaving_user_id
  ) THEN
    UPDATE "User"
       SET status = 'offboarded',
           "offboardedAt" = now(),
           "offboardedToUserId" = p_destination_user_id
     WHERE id = p_leaving_user_id;
  ELSE
    UPDATE "User"
       SET "offboardedAt" = now(),
           "offboardedToUserId" = p_destination_user_id
     WHERE id = p_leaving_user_id;
  END IF;

  RETURN json_build_object(
    'dryRun', false,
    'contactsMoved', v_contact_count,
    'dealsMoved', v_deal_count,
    'demosMoved', v_demo_count
  );
END;
$$;


--
-- Name: purge_credit_rows_for_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_credit_rows_for_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- TG_ARGV[0] is the accountType this trigger guards ('space' | 'company').
  DELETE FROM "CreditLot" WHERE "accountType" = TG_ARGV[0] AND "accountId" = OLD.id;
  DELETE FROM "CreditTxn" WHERE "accountType" = TG_ARGV[0] AND "accountId" = OLD.id;
  RETURN OLD;
END;
$$;


--
-- Name: refund_credit_txn(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refund_credit_txn(p_txn_id text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_txn     RECORD;
  v_debit   jsonb;
  v_updated int;
BEGIN
  SELECT * INTO v_txn FROM "CreditTxn" WHERE id = p_txn_id AND reason = 'spend' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM "CreditTxn" WHERE "refundedTxnId" = p_txn_id) THEN RETURN; END IF;

  FOR v_debit IN SELECT * FROM jsonb_array_elements(v_txn.metadata -> 'debits')
  LOOP
    -- Return to the original lot only while it's still spendable.
    UPDATE "CreditLot"
       SET remaining = remaining + (v_debit ->> 'take')::int
     WHERE id = v_debit ->> 'lotId'
       AND ("expiresAt" IS NULL OR "expiresAt" > now());
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
      -- Original lot expired/gone: re-grant into a fresh 30-day lot so the
      -- refunded credits don't vanish into a dead lot.
      INSERT INTO "CreditLot" ("accountType", "accountId", amount, remaining, reason, "expiresAt")
      VALUES (v_txn."accountType", v_txn."accountId",
              (v_debit ->> 'take')::int, (v_debit ->> 'take')::int,
              'refund', now() + interval '30 days');
    END IF;
  END LOOP;

  INSERT INTO "CreditTxn" ("accountType", "accountId", delta, workflow, "spaceId", "userId", reason, "refundedTxnId")
  VALUES (v_txn."accountType", v_txn."accountId", -v_txn.delta, v_txn.workflow, v_txn."spaceId", v_txn."userId", 'refund', p_txn_id);
END;
$$;


--
-- Name: reorder_deal(text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reorder_deal(p_deal_id text, p_new_stage_id text, p_new_position integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Shift deals at or after the target position up by one to make room
  UPDATE "Deal"
  SET position = position + 1
  WHERE "stageId" = p_new_stage_id
    AND position >= p_new_position
    AND id != p_deal_id;

  -- Place the deal at its new stage and position
  UPDATE "Deal"
  SET "stageId"   = p_new_stage_id,
      position    = p_new_position,
      "stageChangedAt" = CASE WHEN "stageId" IS DISTINCT FROM p_new_stage_id
                              THEN now() ELSE "stageChangedAt" END,
      "updatedAt" = now()
  WHERE id = p_deal_id;
END;
$$;


--
-- Name: resolve_billing_account_for_space(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_billing_account_for_space(p_space_id text) RETURNS TABLE(account_type text, account_id text)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_space  RECORD;
  v_brk    RECORD;
  v_member text;
BEGIN
  SELECT id, plan, "companyId", "ownerId" INTO v_space FROM "Space" WHERE id = p_space_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_space."companyId" IS NOT NULL THEN
    SELECT id, plan INTO v_brk FROM "Company" WHERE id = v_space."companyId";
    IF FOUND AND v_brk.plan IN ('team', 'team_plus') THEN
      SELECT "userId" INTO v_member FROM "CompanyMembership"
        WHERE "companyId" = v_space."companyId" AND "userId" = v_space."ownerId" LIMIT 1;
      IF v_member IS NOT NULL THEN
        account_type := 'company'; account_id := v_brk.id; RETURN NEXT; RETURN;
      END IF;
    END IF;
  END IF;

  account_type := 'space'; account_id := v_space.id; RETURN NEXT;
END;
$$;


--
-- Name: routine_next_run_at(text, integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.routine_next_run_at(p_cadence text, p_hour integer, p_from timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  candidate timestamptz;
BEGIN
  -- hourly: the next top of the hour.
  IF p_cadence = 'hourly' THEN
    RETURN date_trunc('hour', p_from) + interval '1 hour';
  END IF;

  -- daily / weekdays: the next p_hour:00 UTC strictly after p_from.
  candidate := date_trunc('day', p_from) + make_interval(hours => p_hour);
  IF candidate <= p_from THEN
    candidate := candidate + interval '1 day';
  END IF;

  -- weekdays: roll forward off Saturday (6) and Sunday (0).
  IF p_cadence = 'weekdays' THEN
    WHILE extract(dow FROM candidate) IN (0, 6) LOOP
      candidate := candidate + interval '1 day';
    END LOOP;
  END IF;

  RETURN candidate;
END;
$$;


--
-- Name: routine_next_run_at(text, integer, timestamp with time zone, integer, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.routine_next_run_at(p_cadence text, p_hour integer, p_from timestamp with time zone, p_day_of_month integer DEFAULT NULL::integer, p_days_of_week text[] DEFAULT NULL::text[]) RETURNS timestamp with time zone
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  candidate timestamptz;
  target_dow integer;
  i integer;
  -- JS-style: Sun=0, Mon=1, …, Sat=6. Postgres extract(dow) returns the same.
  dow_map jsonb := '{"sun":0,"mon":1,"tue":2,"wed":3,"thu":4,"fri":5,"sat":6}'::jsonb;
BEGIN
  -- hourly: the next top of the hour.
  IF p_cadence = 'hourly' THEN
    RETURN date_trunc('hour', p_from) + interval '1 hour';
  END IF;

  -- daily / weekdays / monthly / custom — they all want the next p_hour:00 UTC
  -- strictly after p_from, then optionally roll forward to land on a valid day.
  candidate := date_trunc('day', p_from) + make_interval(hours => p_hour);
  IF candidate <= p_from THEN
    candidate := candidate + interval '1 day';
  END IF;

  IF p_cadence = 'weekdays' THEN
    WHILE extract(dow FROM candidate) IN (0, 6) LOOP
      candidate := candidate + interval '1 day';
    END LOOP;
    RETURN candidate;
  END IF;

  IF p_cadence = 'monthly' THEN
    -- Walk forward day-by-day until we hit the chosen day-of-month. At most
    -- 31 iterations; cheap and correct across month boundaries.
    FOR i IN 1..62 LOOP
      EXIT WHEN extract(day FROM candidate) = p_day_of_month;
      candidate := candidate + interval '1 day';
    END LOOP;
    RETURN candidate;
  END IF;

  IF p_cadence = 'custom' THEN
    -- Walk forward day-by-day until the candidate's dow matches one of the
    -- selected days. At most 7 iterations.
    FOR i IN 1..7 LOOP
      target_dow := extract(dow FROM candidate)::integer;
      EXIT WHEN EXISTS (
        SELECT 1
        FROM unnest(p_days_of_week) AS d
        WHERE (dow_map ->> d)::integer = target_dow
      );
      candidate := candidate + interval '1 day';
    END LOOP;
    RETURN candidate;
  END IF;

  -- daily (default)
  RETURN candidate;
END;
$$;


--
-- Name: routine_set_next_run(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.routine_set_next_run() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW."nextRunAt" := routine_next_run_at(
    NEW."cadence",
    NEW."hour",
    now(),
    NEW."dayOfMonth",
    NEW."daysOfWeek"
  );
  NEW."updatedAt" := now();
  RETURN NEW;
END;
$$;


--
-- Name: search_knowledge_docs(text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_knowledge_docs(query_text text, filter_category text DEFAULT NULL::text, result_limit integer DEFAULT 5) RETURNS TABLE(id text, category text, title text, content text, rank real)
    LANGUAGE sql STABLE
    AS $$
  SELECT
    d.id,
    d.category,
    d.title,
    d.content,
    ts_rank_cd(d."searchVector", websearch_to_tsquery('english', query_text)) AS rank
  FROM "AppKnowledgeDoc" d
  WHERE
    d."searchVector" @@ websearch_to_tsquery('english', query_text)
    AND (filter_category IS NULL OR filter_category = '' OR d.category = filter_category)
  ORDER BY rank DESC
  LIMIT result_limit;
$$;


--
-- Name: spend_credits(text, text, integer, text, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.spend_credits(p_account_type text, p_account_id text, p_amount integer, p_workflow text, p_space_id text, p_user_id text, p_metadata jsonb) RETURNS TABLE(ok boolean, balance integer, txn_id text)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_need    integer := p_amount;
  v_take    integer;
  v_lot     RECORD;
  v_debits  jsonb := '[]'::jsonb;
  v_txn     text;
  v_balance integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'spend_credits: amount must be a positive integer, got %', p_amount;
  END IF;

  PERFORM 1 FROM "CreditLot"
   WHERE "accountType" = p_account_type AND "accountId" = p_account_id
     AND remaining > 0 AND ("expiresAt" IS NULL OR "expiresAt" > now())
   FOR UPDATE;

  SELECT COALESCE(SUM(remaining), 0) INTO v_balance FROM "CreditLot"
   WHERE "accountType" = p_account_type AND "accountId" = p_account_id
     AND remaining > 0 AND ("expiresAt" IS NULL OR "expiresAt" > now());

  IF v_balance < p_amount THEN
    RETURN QUERY SELECT false, v_balance, NULL::text;
    RETURN;
  END IF;

  FOR v_lot IN
    SELECT id, remaining FROM "CreditLot"
     WHERE "accountType" = p_account_type AND "accountId" = p_account_id
       AND remaining > 0 AND ("expiresAt" IS NULL OR "expiresAt" > now())
     ORDER BY ("expiresAt" IS NULL), "expiresAt" ASC, "createdAt" ASC
  LOOP
    EXIT WHEN v_need <= 0;
    v_take := LEAST(v_lot.remaining, v_need);
    UPDATE "CreditLot" SET remaining = remaining - v_take WHERE id = v_lot.id;
    v_debits := v_debits || jsonb_build_object('lotId', v_lot.id, 'take', v_take);
    v_need := v_need - v_take;
  END LOOP;

  INSERT INTO "CreditTxn" ("accountType", "accountId", delta, workflow, "spaceId", "userId", reason, metadata)
  VALUES (p_account_type, p_account_id, -p_amount, p_workflow, p_space_id, p_user_id, 'spend',
          jsonb_set(COALESCE(p_metadata, '{}'::jsonb), '{debits}', v_debits))
  RETURNING id INTO v_txn;

  RETURN QUERY SELECT true, (v_balance - p_amount), v_txn;
END;
$$;


--
-- Name: stamp_brief_enabled_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stamp_brief_enabled_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."briefEnabled" = true
     AND (OLD."briefEnabled" IS DISTINCT FROM NEW."briefEnabled" OR NEW."briefEnabledAt" IS NULL)
  THEN
    NEW."briefEnabledAt" := now();
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: sync_commission_ledger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_commission_ledger() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_company_id   text;
  v_owner_id       text;
  v_agent_rate     numeric(5,2);
  v_manager_rate    numeric(5,2);
  v_deal_value     numeric(12,2);
BEGIN
  ---------------------------------------------------------------------
  -- Resolve the deal's Space. A deal in a non-company workspace
  -- (companyId IS NULL) gets no ledger row — solo agents opted out.
  ---------------------------------------------------------------------
  SELECT s."companyId", s."ownerId"
    INTO v_company_id, v_owner_id
    FROM "Space" s
   WHERE s.id = NEW."spaceId";

  IF v_company_id IS NULL THEN
    RETURN NEW;
  END IF;

  ---------------------------------------------------------------------
  -- Snapshot the company's current default rates. The ledger row
  -- keeps these forever; future rate edits don't mutate history.
  ---------------------------------------------------------------------
  SELECT b."defaultAgentRate", b."defaultManagerRate"
    INTO v_agent_rate, v_manager_rate
    FROM "Company" b
   WHERE b.id = v_company_id;

  IF v_agent_rate IS NULL OR v_manager_rate IS NULL THEN
    -- Company row missing or rates NULL (shouldn't happen with the
    -- NOT NULL defaults above, but fail closed rather than insert
    -- garbage).
    RETURN NEW;
  END IF;

  v_deal_value := COALESCE(NEW.value, 0);

  ---------------------------------------------------------------------
  -- Insert. UNIQUE (dealId) + ON CONFLICT DO NOTHING means
  -- re-entering 'won' is a no-op after the first transition.
  ---------------------------------------------------------------------
  INSERT INTO "CommissionLedger" (
    "companyId",
    "agentUserId",
    "dealId",
    "closedAt",
    "dealValue",
    "agentRate",
    "managerRate",
    "referralRate",
    "agentAmount",
    "managerAmount",
    "referralAmount",
    status
  ) VALUES (
    v_company_id,
    v_owner_id,
    NEW.id,
    now(),
    v_deal_value,
    v_agent_rate,
    v_manager_rate,
    0,
    ROUND((v_deal_value * v_agent_rate  / 100)::numeric, 2),
    ROUND((v_deal_value * v_manager_rate / 100)::numeric, 2),
    0,
    'pending'
  )
  ON CONFLICT ("dealId") DO NOTHING;

  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW."updatedAt" = now(); RETURN NEW; END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: AIUserProfile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AIUserProfile" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "displayName" text,
    "businessFocus" text[] DEFAULT '{}'::text[] NOT NULL,
    "yearsExperience" integer,
    "workingStyle" text,
    "communicationTone" text,
    "currentGoals" text,
    "quirksAndPreferences" text,
    "agentPersonalizationNote" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    role text,
    "zipCode" text,
    "leadSources" text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: AffiliateAccount; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AffiliateAccount" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "userId" text NOT NULL,
    "spaceId" text NOT NULL,
    "fpPromoterId" text NOT NULL,
    "refLink" text NOT NULL,
    "refToken" text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: AffiliateCommission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AffiliateCommission" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "partnerId" text NOT NULL,
    "referralId" text,
    "orderId" text,
    "amountCents" integer DEFAULT 0 NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    level integer DEFAULT 1 NOT NULL,
    "payoutId" text,
    note text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "approvedAt" timestamp with time zone,
    "platformFeeCents" integer DEFAULT 0 NOT NULL,
    "netCents" integer,
    source text DEFAULT 'marketplace'::text NOT NULL,
    "periodNumber" integer DEFAULT 1 NOT NULL,
    "stripeInvoiceId" text,
    "settledAt" timestamp with time zone,
    "settlementInvoiceId" text,
    "reversedAt" timestamp with time zone,
    "reversalReason" text,
    "matureAt" timestamp with time zone,
    CONSTRAINT "AffiliateCommission_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'paid'::text, 'rejected'::text, 'reversed'::text])))
);


--
-- Name: AffiliatePartner; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AffiliatePartner" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "programId" text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "clerkUserId" text,
    status text DEFAULT 'pending'::text NOT NULL,
    "payoutMethod" text,
    "payoutDetails" jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "stripeAccountId" text,
    "balanceAdjustmentCents" integer DEFAULT 0 NOT NULL,
    "invitedBySeller" boolean DEFAULT false NOT NULL,
    "parentPartnerId" text,
    CONSTRAINT "AffiliatePartner_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text])))
);


--
-- Name: AffiliatePayout; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AffiliatePayout" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "partnerId" text NOT NULL,
    "amountCents" integer DEFAULT 0 NOT NULL,
    method text,
    status text DEFAULT 'pending'::text NOT NULL,
    "periodStart" timestamp with time zone,
    "periodEnd" timestamp with time zone,
    "paidAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "platformFeeCents" integer DEFAULT 0 NOT NULL,
    "stripeTransferId" text,
    CONSTRAINT "AffiliatePayout_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: AffiliateProgram; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AffiliateProgram" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    name text DEFAULT 'Default program'::text NOT NULL,
    "commissionType" text DEFAULT 'percent'::text NOT NULL,
    "commissionValue" numeric DEFAULT 20 NOT NULL,
    recurring boolean DEFAULT false NOT NULL,
    "recurringMonths" integer,
    "cookieWindowDays" integer DEFAULT 30 NOT NULL,
    "autoApproveAffiliates" boolean DEFAULT false NOT NULL,
    "autoApproveCommissions" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "tier2Enabled" boolean DEFAULT false NOT NULL,
    "tier2Percent" numeric DEFAULT 10 NOT NULL,
    "holdDays" integer DEFAULT 14 NOT NULL,
    "minPayoutCents" integer DEFAULT 2000 NOT NULL,
    CONSTRAINT "AffiliateProgram_commissionType_check" CHECK (("commissionType" = ANY (ARRAY['percent'::text, 'flat'::text]))),
    CONSTRAINT "AffiliateProgram_commissionValue_check" CHECK (("commissionValue" >= (0)::numeric)),
    CONSTRAINT "AffiliateProgram_holdDays_check" CHECK ((("holdDays" >= 0) AND ("holdDays" <= 180))),
    CONSTRAINT "AffiliateProgram_tier2Percent_check" CHECK ((("tier2Percent" >= (0)::numeric) AND ("tier2Percent" <= (50)::numeric)))
);


--
-- Name: AgentActivityLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentActivityLog" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "runId" text NOT NULL,
    "agentType" text NOT NULL,
    "actionType" text NOT NULL,
    reasoning text,
    outcome text NOT NULL,
    "relatedContactId" text,
    "relatedDealId" text,
    reversible boolean DEFAULT true NOT NULL,
    "reversedAt" timestamp with time zone,
    metadata jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "AgentActivityLog_outcome_check" CHECK ((outcome = ANY (ARRAY['completed'::text, 'queued_for_approval'::text, 'suggested'::text, 'failed'::text])))
);


--
-- Name: AgentDraft; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentDraft" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "contactId" text,
    "dealId" text,
    channel text NOT NULL,
    subject text,
    content text NOT NULL,
    reasoning text,
    priority integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "expiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    confidence integer,
    outcome character varying(30),
    "outcomeDetectedAt" timestamp with time zone,
    feedback_action text,
    edit_distance integer,
    decision_ms integer,
    outcome_signal text,
    outcome_checked_at timestamp with time zone,
    "idempotencyKey" text,
    "triggerSource" jsonb,
    CONSTRAINT "AgentDraft_channel_check" CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text, 'note'::text]))),
    CONSTRAINT "AgentDraft_confidence_check" CHECK (((confidence >= 0) AND (confidence <= 100))),
    CONSTRAINT "AgentDraft_decision_ms_check" CHECK ((decision_ms >= 0)),
    CONSTRAINT "AgentDraft_edit_distance_check" CHECK ((edit_distance >= 0)),
    CONSTRAINT "AgentDraft_feedback_action_check" CHECK ((feedback_action = ANY (ARRAY['approved'::text, 'edited_and_approved'::text, 'rejected'::text, 'held'::text]))),
    CONSTRAINT "AgentDraft_outcome_check" CHECK (((outcome)::text = ANY ((ARRAY['responded'::character varying, 'no_response'::character varying, 'bounced'::character varying, 'unsubscribed'::character varying, 'meeting_booked'::character varying])::text[]))),
    CONSTRAINT "AgentDraft_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'dismissed'::text, 'sent'::text])))
);


--
-- Name: AgentGoal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentGoal" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "spaceId" text NOT NULL,
    "contactId" text,
    "dealId" text,
    "goalType" character varying(50) NOT NULL,
    description text NOT NULL,
    instructions text,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    "completedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "AgentGoal_goalType_check" CHECK ((("goalType")::text = ANY ((ARRAY['follow_up_sequence'::character varying, 'demo_booking'::character varying, 'offer_progress'::character varying, 'deal_close'::character varying, 'reengagement'::character varying, 'custom'::character varying])::text[]))),
    CONSTRAINT "AgentGoal_status_check" CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'completed'::character varying, 'cancelled'::character varying, 'paused'::character varying])::text[])))
);


--
-- Name: AgentMemory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentMemory" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "entityType" text,
    "entityId" text,
    "memoryType" text NOT NULL,
    content text NOT NULL,
    embedding public.vector(1536),
    importance double precision DEFAULT 0.5 NOT NULL,
    "expiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "taskId" text,
    "sourceRunId" text,
    "sourceToolName" text,
    "sourceConversationId" text,
    CONSTRAINT "AgentMemory_entityType_check" CHECK (("entityType" = ANY (ARRAY['contact'::text, 'deal'::text, 'space'::text]))),
    CONSTRAINT "AgentMemory_memoryType_check" CHECK (("memoryType" = ANY (ARRAY['fact'::text, 'preference'::text, 'observation'::text, 'reminder'::text])))
);


--
-- Name: COLUMN "AgentMemory"."sourceRunId"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."AgentMemory"."sourceRunId" IS 'The orchestrator run ID that created this memory';


--
-- Name: COLUMN "AgentMemory"."sourceToolName"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."AgentMemory"."sourceToolName" IS 'The tool name (e.g. find_contacts) that triggered this memory write';


--
-- Name: COLUMN "AgentMemory"."sourceConversationId"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."AgentMemory"."sourceConversationId" IS 'The chat conversation ID if memory was created during a chat turn';


--
-- Name: AgentPausedRun; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentPausedRun" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "userId" text NOT NULL,
    "conversationId" text,
    "runState" text NOT NULL,
    approvals jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "expiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "AgentPausedRun_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'resumed'::text, 'cancelled'::text, 'expired'::text])))
);


--
-- Name: AgentQuestion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentQuestion" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "spaceId" text NOT NULL,
    "runId" character varying(100) NOT NULL,
    "agentType" character varying(50) NOT NULL,
    question text NOT NULL,
    context text,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    answer text,
    "answeredAt" timestamp with time zone,
    priority integer DEFAULT 0 NOT NULL,
    "contactId" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "AgentQuestion_status_check" CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'answered'::character varying, 'expired'::character varying])::text[])))
);


--
-- Name: AgentSettings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentSettings" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    "dailyTokenBudget" integer DEFAULT 50000 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "chatModel" text
);


--
-- Name: AgentTask; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentTask" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'queued'::text NOT NULL,
    "triggerSource" text DEFAULT 'manual'::text NOT NULL,
    "goalDescription" text,
    "parentTaskId" text,
    "totalSteps" integer DEFAULT 0 NOT NULL,
    "completedSteps" integer DEFAULT 0 NOT NULL,
    "inputTokens" integer DEFAULT 0 NOT NULL,
    "outputTokens" integer DEFAULT 0 NOT NULL,
    "estimatedCostUsd" numeric(10,6) DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    "startedAt" timestamp with time zone,
    "completedAt" timestamp with time zone,
    "cancelledAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "AgentTask_status_check" CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'paused'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: AgentTrajectory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentTrajectory" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "runId" text NOT NULL,
    "spaceId" text NOT NULL,
    "startedAt" timestamp with time zone NOT NULL,
    "endedAt" timestamp with time zone,
    status text NOT NULL,
    trigger jsonb,
    model text,
    "totalTokens" integer DEFAULT 0,
    "toolCalls" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "finalSummary" text,
    extra jsonb DEFAULT '{}'::jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "cachedTokens" integer DEFAULT 0 NOT NULL,
    provider text DEFAULT 'unknown'::text NOT NULL,
    CONSTRAINT "AgentTrajectory_cachedTokens_check" CHECK (("cachedTokens" >= 0)),
    CONSTRAINT "AgentTrajectory_status_check" CHECK ((status = ANY (ARRAY['completed'::text, 'error'::text, 'timeout'::text, 'killed'::text, 'guardrail_blocked'::text])))
);


--
-- Name: COLUMN "AgentTrajectory"."cachedTokens"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."AgentTrajectory"."cachedTokens" IS 'Input tokens served from provider prompt cache (free or discounted). Subset of totalTokens. 0 when the provider has no caching path.';


--
-- Name: COLUMN "AgentTrajectory".provider; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."AgentTrajectory".provider IS 'OpenRouter provider prefix: anthropic | openai | xai | deepseek | google | moonshotai | qwen | unknown.';


--
-- Name: Announcement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Announcement" (
    id text NOT NULL,
    message text NOT NULL,
    title text,
    severity text DEFAULT 'info'::text NOT NULL,
    "targetSegment" text DEFAULT 'all'::text NOT NULL,
    "linkUrl" text,
    "linkLabel" text,
    dismissible boolean DEFAULT true NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "startsAt" timestamp with time zone,
    "endsAt" timestamp with time zone,
    "createdBy" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "Announcement_severity_check" CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT "Announcement_targetSegment_check" CHECK (("targetSegment" = ANY (ARRAY['all'::text, 'trial'::text, 'active'::text, 'past_due'::text, 'admin'::text])))
);


--
-- Name: AnnouncementDismissal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AnnouncementDismissal" (
    id text NOT NULL,
    "announcementId" text NOT NULL,
    "userId" text NOT NULL,
    "dismissedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: AppKnowledgeDoc; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AppKnowledgeDoc" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    category text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(content, ''::text)))) STORED,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ApplicationMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ApplicationMessage" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "contactId" text NOT NULL,
    "spaceId" text NOT NULL,
    "senderType" text NOT NULL,
    content text NOT NULL,
    "readAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "ApplicationMessage_content_check" CHECK ((char_length(content) <= 2000)),
    CONSTRAINT "ApplicationMessage_senderType_check" CHECK (("senderType" = ANY (ARRAY['applicant'::text, 'seller'::text])))
);


--
-- Name: ApplicationStatusUpdate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ApplicationStatusUpdate" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "contactId" text NOT NULL,
    "spaceId" text NOT NULL,
    "fromStatus" text,
    "toStatus" text NOT NULL,
    note text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: Artifact; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Artifact" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "taskId" text,
    "stepId" text,
    "artifactType" text NOT NULL,
    title text NOT NULL,
    "contentType" text DEFAULT 'text/plain'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    "currentVersionId" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "Artifact_artifactType_check" CHECK (("artifactType" = ANY (ARRAY['draft_email'::text, 'draft_sms'::text, 'deal_update'::text, 'contact_update'::text, 'demo_booking'::text, 'goal_plan'::text, 'report'::text, 'raw_output'::text]))),
    CONSTRAINT "Artifact_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'rejected'::text, 'superseded'::text])))
);


--
-- Name: ArtifactVersion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ArtifactVersion" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "artifactId" text NOT NULL,
    "spaceId" text NOT NULL,
    "versionNumber" integer DEFAULT 1 NOT NULL,
    content text NOT NULL,
    "contentHash" text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    "createdByAgent" text DEFAULT 'cola'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: Attachment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Attachment" (
    id text NOT NULL,
    "spaceId" text NOT NULL,
    "userId" text,
    "conversationId" text,
    filename text NOT NULL,
    "mimeType" text NOT NULL,
    "sizeBytes" integer NOT NULL,
    "storagePath" text NOT NULL,
    "publicUrl" text NOT NULL,
    "extractedText" text,
    "extractionStatus" text DEFAULT 'pending'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "Attachment_extractionStatus_check" CHECK (("extractionStatus" = ANY (ARRAY['pending'::text, 'skipped'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: AuditLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AuditLog" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "clerkId" text,
    "actorId" text,
    "ipAddress" text,
    action text NOT NULL,
    resource text NOT NULL,
    "resourceId" text,
    "spaceId" text,
    metadata jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: Brief; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Brief" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "forDate" date NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    payload jsonb NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "seenAt" timestamp with time zone,
    "actedAt" timestamp with time zone,
    "cardMeta" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "cardTaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "emailSentAt" timestamp with time zone,
    "smsSentAt" timestamp with time zone,
    "emailMessageId" text,
    "smsMessageId" text,
    "briefDeliveryErrorCode" text
);


--
-- Name: BriefTipHistory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BriefTipHistory" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "tipCategory" text NOT NULL,
    "subjectId" text,
    "firedAt" timestamp with time zone DEFAULT now() NOT NULL,
    outcome text DEFAULT 'shown'::text NOT NULL,
    CONSTRAINT "BriefTipHistory_outcome_check" CHECK ((outcome = ANY (ARRAY['shown'::text, 'acted'::text, 'dismissed'::text])))
);


--
-- Name: CalendarEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CalendarEvent" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    title text NOT NULL,
    description text,
    date date NOT NULL,
    "time" text,
    color text DEFAULT 'gray'::text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: CalendarEventMirror; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CalendarEventMirror" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "externalProvider" text NOT NULL,
    "externalEventId" text,
    title text NOT NULL,
    start timestamp with time zone NOT NULL,
    "end" timestamp with time zone NOT NULL,
    attendees jsonb DEFAULT '[]'::jsonb NOT NULL,
    "sourceDemoId" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "createdBy" text DEFAULT 'agent'::text NOT NULL,
    CONSTRAINT "CalendarEventMirror_createdBy_check" CHECK (("createdBy" = ANY (ARRAY['agent'::text, 'seller'::text])))
);


--
-- Name: CalendarNote; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CalendarNote" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    date date NOT NULL,
    note text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: CallLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CallLog" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "contactId" text,
    direction text DEFAULT 'outbound'::text NOT NULL,
    "fromNumber" text NOT NULL,
    "toNumber" text NOT NULL,
    "telnyxCallId" text,
    status text DEFAULT 'initiated'::text NOT NULL,
    "recordingUrl" text,
    transcript text,
    summary text,
    "durationSec" integer,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CallLog_direction_check" CHECK ((direction = ANY (ARRAY['outbound'::text, 'inbound'::text]))),
    CONSTRAINT "CallLog_status_check" CHECK ((status = ANY (ARRAY['initiated'::text, 'ringing'::text, 'answered'::text, 'completed'::text, 'failed'::text, 'no_answer'::text])))
);


--
-- Name: ChatUsage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChatUsage" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "userId" text,
    "conversationId" text,
    model text NOT NULL,
    "promptTokens" integer DEFAULT 0 NOT NULL,
    "completionTokens" integer DEFAULT 0 NOT NULL,
    "costUsd" numeric(10,6) DEFAULT 0 NOT NULL,
    runtime text DEFAULT 'modal'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "cachedTokens" integer DEFAULT 0 NOT NULL,
    provider text DEFAULT 'unknown'::text NOT NULL,
    route text DEFAULT 'agent'::text NOT NULL,
    CONSTRAINT "ChatUsage_cachedTokens_check" CHECK (("cachedTokens" >= 0)),
    CONSTRAINT "ChatUsage_completionTokens_check" CHECK (("completionTokens" >= 0)),
    CONSTRAINT "ChatUsage_promptTokens_check" CHECK (("promptTokens" >= 0))
);


--
-- Name: COLUMN "ChatUsage"."cachedTokens"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."ChatUsage"."cachedTokens" IS 'Input tokens served from provider prompt cache (free or discounted). Subset of promptTokens. 0 when the provider has no caching path.';


--
-- Name: COLUMN "ChatUsage".provider; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."ChatUsage".provider IS 'OpenRouter provider prefix: anthropic | openai | xai | deepseek | google | moonshotai | qwen | unknown.';


--
-- Name: COLUMN "ChatUsage".route; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."ChatUsage".route IS 'Dual-path router outcome: direct | agent | direct→agent. Default agent for backward compat.';


--
-- Name: ClientAuthCode; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientAuthCode" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "emailLower" text NOT NULL,
    "codeHash" text NOT NULL,
    purpose text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "consumedAt" timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "ClientAuthCode_purpose_check" CHECK ((purpose = ANY (ARRAY['verify'::text, 'login'::text, 'reset'::text])))
);


--
-- Name: ClientDocument; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientDocument" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "contactId" text NOT NULL,
    "spaceId" text NOT NULL,
    "fileKey" text NOT NULL,
    "fileName" text NOT NULL,
    "contentType" text,
    "sizeBytes" integer,
    "uploadedBy" text DEFAULT 'client'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ClientInfoRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientInfoRequest" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "contactId" text NOT NULL,
    "spaceId" text NOT NULL,
    message text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    response text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "fulfilledAt" timestamp with time zone,
    CONSTRAINT "ClientInfoRequest_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'fulfilled'::text, 'dismissed'::text])))
);


--
-- Name: ClientMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientMessage" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "contactId" text NOT NULL,
    "spaceId" text NOT NULL,
    "senderType" text NOT NULL,
    body text NOT NULL,
    "readAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "ClientMessage_senderType_check" CHECK (("senderType" = ANY (ARRAY['client'::text, 'seller'::text])))
);


--
-- Name: ClientUser; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClientUser" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    email text NOT NULL,
    "emailLower" text NOT NULL,
    "passwordHash" text NOT NULL,
    name text,
    phone text,
    "emailVerifiedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: CmaReport; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CmaReport" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "subjectAddress" text NOT NULL,
    "subjectProductId" text,
    "shareToken" text NOT NULL,
    title text,
    status text DEFAULT 'draft'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CmaReport_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))
);


--
-- Name: CommissionLedger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CommissionLedger" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "companyId" text NOT NULL,
    "agentUserId" text,
    "dealId" text,
    "closedAt" timestamp with time zone NOT NULL,
    "dealValue" numeric(12,2) NOT NULL,
    "agentRate" numeric(5,2) NOT NULL,
    "managerRate" numeric(5,2) NOT NULL,
    "referralRate" numeric(5,2) DEFAULT 0 NOT NULL,
    "referralUserId" text,
    "agentAmount" numeric(12,2) NOT NULL,
    "managerAmount" numeric(12,2) NOT NULL,
    "referralAmount" numeric(12,2) DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "payoutAt" timestamp with time zone,
    notes text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CommissionLedger_agentRate_range" CHECK ((("agentRate" IS NULL) OR (("agentRate" >= (0)::numeric) AND ("agentRate" <= (100)::numeric)))),
    CONSTRAINT "CommissionLedger_managerRate_range" CHECK ((("managerRate" IS NULL) OR (("managerRate" >= (0)::numeric) AND ("managerRate" <= (100)::numeric)))),
    CONSTRAINT "CommissionLedger_referralRate_range" CHECK ((("referralRate" IS NULL) OR (("referralRate" >= (0)::numeric) AND ("referralRate" <= (100)::numeric)))),
    CONSTRAINT "CommissionLedger_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'void'::text])))
);


--
-- Name: CommissionSplit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CommissionSplit" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "dealId" text NOT NULL,
    "spaceId" text NOT NULL,
    party text NOT NULL,
    label text NOT NULL,
    basis text NOT NULL,
    "percentOfGci" numeric(6,3),
    "flatAmount" numeric(14,2),
    "paidAt" timestamp with time zone,
    notes text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CommissionSplit_basis_check" CHECK ((basis = ANY (ARRAY['percent'::text, 'flat'::text]))),
    CONSTRAINT "CommissionSplit_basis_values" CHECK ((((basis = 'percent'::text) AND ("percentOfGci" IS NOT NULL) AND ("flatAmount" IS NULL)) OR ((basis = 'flat'::text) AND ("flatAmount" IS NOT NULL) AND ("percentOfGci" IS NULL)))),
    CONSTRAINT "CommissionSplit_percent_range" CHECK ((("percentOfGci" IS NULL) OR (("percentOfGci" >= (0)::numeric) AND ("percentOfGci" <= (100)::numeric))))
);


--
-- Name: Company; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Company" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    name text NOT NULL,
    "ownerId" text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    "websiteUrl" text,
    "logoUrl" text,
    "joinCode" text,
    "companyFormConfig" jsonb,
    "companyRentalFormConfig" jsonb,
    "companyBuyerFormConfig" jsonb,
    "companyRentalScoringModel" jsonb,
    "companyBuyerScoringModel" jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "privacyPolicyHtml" text,
    "officeAddress" text,
    "officePhone" text,
    "agentCount" text,
    "companyType" text,
    "primaryMarket" text,
    "commissionStructure" text,
    "geographicCoverage" text,
    "defaultAgentRate" numeric(5,2) DEFAULT 2.5 NOT NULL,
    "defaultManagerRate" numeric(5,2) DEFAULT 0.5 NOT NULL,
    plan text DEFAULT 'starter'::text NOT NULL,
    "seatLimit" integer,
    "stripeCustomerId" text,
    "stripeSubscriptionId" text,
    "stripeSubscriptionStatus" text DEFAULT 'inactive'::text NOT NULL,
    "stripePeriodEnd" timestamp with time zone,
    "autoAssignEnabled" boolean DEFAULT false NOT NULL,
    "assignmentMethod" text DEFAULT 'manual'::text NOT NULL,
    "lastAssignedUserId" text,
    "companyLicenseNumber" text,
    "companyFairHousingNotice" text,
    "companyShowEqualHousingMark" boolean DEFAULT false NOT NULL,
    "leadRoutingRule" text DEFAULT 'manual'::text NOT NULL,
    "slaEnabled" boolean DEFAULT false NOT NULL,
    "slaFirstResponseMinutes" integer DEFAULT 60 NOT NULL,
    "slaEscalateMinutes" integer DEFAULT 120 NOT NULL,
    "planActivatedAt" timestamp with time zone,
    CONSTRAINT "Company_assignmentMethod_check" CHECK (("assignmentMethod" = ANY (ARRAY['manual'::text, 'round_robin'::text, 'score_based'::text]))),
    CONSTRAINT "Company_commissionStructure_check" CHECK (("commissionStructure" = ANY (ARRAY['flat_fee'::text, 'percentage_split'::text, 'hybrid'::text]))),
    CONSTRAINT "Company_companyType_check" CHECK (("companyType" = ANY (ARRAY['independent'::text, 'franchise'::text, 'virtual'::text]))),
    CONSTRAINT "Company_defaultAgentRate_range" CHECK ((("defaultAgentRate" IS NULL) OR (("defaultAgentRate" >= (0)::numeric) AND ("defaultAgentRate" <= (100)::numeric)))),
    CONSTRAINT "Company_defaultManagerRate_range" CHECK ((("defaultManagerRate" IS NULL) OR (("defaultManagerRate" >= (0)::numeric) AND ("defaultManagerRate" <= (100)::numeric)))),
    CONSTRAINT "Company_leadRoutingRule_check" CHECK (("leadRoutingRule" = ANY (ARRAY['manual'::text, 'round_robin'::text, 'fewest_active'::text]))),
    CONSTRAINT "Company_plan_check" CHECK ((plan = ANY (ARRAY['starter'::text, 'team'::text, 'team_plus'::text, 'enterprise'::text]))),
    CONSTRAINT "Company_primaryMarket_check" CHECK (("primaryMarket" = ANY (ARRAY['residential_rental'::text, 'commercial'::text, 'mixed'::text]))),
    CONSTRAINT "Company_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text]))),
    CONSTRAINT "Company_stripeSubscriptionStatus_check" CHECK (("stripeSubscriptionStatus" = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text, 'canceled'::text, 'unpaid'::text, 'inactive'::text])))
);


--
-- Name: COLUMN "Company"."companyRentalScoringModel"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."Company"."companyRentalScoringModel" IS 'Company-wide default scoring model for rental forms.';


--
-- Name: COLUMN "Company"."companyBuyerScoringModel"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."Company"."companyBuyerScoringModel" IS 'Company-wide default scoring model for buyer forms.';


--
-- Name: CompanyIntegrationConnection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CompanyIntegrationConnection" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "companyId" text NOT NULL,
    "userId" text NOT NULL,
    toolkit text NOT NULL,
    "composioConnectionId" text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    label text,
    "lastError" text,
    "lastUsedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CompanyIntegrationConnection_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text, 'revoked'::text, 'failed'::text])))
);


--
-- Name: CompanyMembership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CompanyMembership" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "companyId" text NOT NULL,
    "userId" text NOT NULL,
    role text NOT NULL,
    "invitedById" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "displayName" text,
    title text,
    bio text,
    "photoUrl" text,
    phone text,
    CONSTRAINT "CompanyMembership_role_check" CHECK ((role = ANY (ARRAY['manager_owner'::text, 'manager_admin'::text, 'seller_member'::text])))
);


--
-- Name: CompanyRemoval; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CompanyRemoval" (
    "companyId" text NOT NULL,
    "userId" text NOT NULL,
    "removedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "removedById" text,
    reason text
);


--
-- Name: CompanyTemplate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CompanyTemplate" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "companyId" text NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    channel text NOT NULL,
    subject text,
    body text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    "publishedAt" timestamp with time zone,
    "publishedCount" integer DEFAULT 0 NOT NULL,
    "createdByUserId" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "publishedVersion" integer,
    CONSTRAINT "CompanyTemplate_category_check" CHECK ((category = ANY (ARRAY['follow-up'::text, 'intro'::text, 'closing'::text, 'demo-invite'::text]))),
    CONSTRAINT "CompanyTemplate_channel_check" CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text, 'note'::text])))
);


--
-- Name: Contact; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Contact" (
    id text NOT NULL,
    "spaceId" text NOT NULL,
    name text NOT NULL,
    email text,
    phone text,
    "leadType" text DEFAULT 'rental'::text NOT NULL,
    address text,
    notes text,
    budget double precision,
    preferences text,
    products text[] DEFAULT '{}'::text[] NOT NULL,
    type text DEFAULT 'QUALIFICATION'::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    "leadScore" double precision,
    "scoreLabel" text,
    "scoreSummary" text,
    "scoringStatus" text DEFAULT 'pending'::text NOT NULL,
    "scoreDetails" jsonb,
    "applicationData" jsonb,
    "followUpAt" timestamp with time zone,
    "lastContactedAt" timestamp with time zone,
    "sourceLabel" text,
    "companyId" text,
    "stageChangedAt" timestamp with time zone,
    "applicationRef" text,
    "applicationStatus" text,
    "applicationStatusNote" text,
    "statusPortalToken" text,
    "consentGiven" boolean,
    "consentTimestamp" timestamp with time zone,
    "consentIp" text,
    "consentPrivacyPolicyUrl" text,
    "formConfigSnapshot" jsonb,
    "formLeadType" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "sourceDemoId" text,
    "snoozedUntil" timestamp with time zone,
    "referralSource" text,
    CONSTRAINT contact_lead_type_check CHECK (("leadType" = ANY (ARRAY['rental'::text, 'buyer'::text, 'seller'::text]))),
    CONSTRAINT contact_scoring_status_check CHECK (("scoringStatus" = ANY (ARRAY['pending'::text, 'scored'::text, 'failed'::text])))
);

ALTER TABLE ONLY public."Contact" REPLICA IDENTITY FULL;


--
-- Name: ContactDocument; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ContactDocument" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "contactId" text NOT NULL,
    "spaceId" text NOT NULL,
    "fileName" text NOT NULL,
    "fileType" text NOT NULL,
    "fileSize" integer NOT NULL,
    "storageKey" text NOT NULL,
    "uploadedBy" text DEFAULT 'guest'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: Conversation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Conversation" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    title text DEFAULT 'New conversation'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: CreatorProfile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CreatorProfile" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "emailLower" text NOT NULL,
    name text NOT NULL,
    "clerkUserId" text,
    bio text,
    niche text,
    "audienceSize" integer DEFAULT 0 NOT NULL,
    channels jsonb DEFAULT '[]'::jsonb NOT NULL,
    "websiteUrl" text,
    "avatarUrl" text,
    listed boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: CreditLot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CreditLot" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "accountType" text NOT NULL,
    "accountId" text NOT NULL,
    amount integer NOT NULL,
    remaining integer NOT NULL,
    reason text NOT NULL,
    "expiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "sourceId" text,
    CONSTRAINT "CreditLot_accountType_check" CHECK (("accountType" = ANY (ARRAY['space'::text, 'company'::text]))),
    CONSTRAINT "CreditLot_amount_check" CHECK ((amount > 0)),
    CONSTRAINT "CreditLot_remaining_check" CHECK ((remaining >= 0))
);


--
-- Name: CreditTxn; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CreditTxn" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "accountType" text NOT NULL,
    "accountId" text NOT NULL,
    delta integer NOT NULL,
    workflow text NOT NULL,
    "spaceId" text,
    "userId" text,
    reason text,
    "refundedTxnId" text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CreditTxn_accountType_check" CHECK (("accountType" = ANY (ARRAY['space'::text, 'company'::text])))
);


--
-- Name: CustomAgent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CustomAgent" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    name text NOT NULL,
    description text,
    "systemPrompt" text DEFAULT ''::text NOT NULL,
    model text DEFAULT 'gpt-4o-mini'::text NOT NULL,
    capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: DeadLetterEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DeadLetterEvent" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "eventType" text NOT NULL,
    "eventPayload" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "errorMessage" text NOT NULL,
    "errorStack" text,
    "attemptCount" integer DEFAULT 1 NOT NULL,
    "firstFailedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "lastFailedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "resolvedAt" timestamp with time zone,
    "resolvedBy" text,
    "resolutionNote" text,
    status text DEFAULT 'pending'::text NOT NULL,
    "taskId" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "DeadLetterEvent_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'retrying'::text, 'resolved'::text, 'abandoned'::text])))
);


--
-- Name: Deal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Deal" (
    id text NOT NULL,
    "spaceId" text NOT NULL,
    title text NOT NULL,
    description text,
    value double precision,
    address text,
    priority text DEFAULT 'MEDIUM'::text NOT NULL,
    "closeDate" timestamp with time zone,
    "stageId" text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    "followUpAt" timestamp with time zone,
    "sourceDemoId" text,
    "commissionRate" numeric(5,2) DEFAULT NULL::numeric,
    probability integer,
    milestones jsonb DEFAULT '[]'::jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "stageChangedAt" timestamp with time zone,
    "closedAt" timestamp with time zone,
    "nextAction" text,
    "nextActionDueAt" timestamp with time zone,
    "wonLostReason" text,
    "wonLostNote" text,
    "productId" text,
    CONSTRAINT "Deal_commissionRate_range" CHECK ((("commissionRate" IS NULL) OR (("commissionRate" >= (0)::numeric) AND ("commissionRate" <= (100)::numeric)))),
    CONSTRAINT "Deal_probability_check" CHECK (((probability >= 0) AND (probability <= 100))),
    CONSTRAINT "Deal_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'won'::text, 'lost'::text, 'on_hold'::text]))),
    CONSTRAINT deal_priority_check CHECK ((priority = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text]))),
    CONSTRAINT deal_status_check CHECK ((status = ANY (ARRAY['active'::text, 'won'::text, 'lost'::text, 'on_hold'::text])))
);

ALTER TABLE ONLY public."Deal" REPLICA IDENTITY FULL;


--
-- Name: DealActivity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DealActivity" (
    id text NOT NULL,
    "dealId" text NOT NULL,
    "spaceId" text NOT NULL,
    type text NOT NULL,
    content text,
    metadata jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "DealActivity_type_check" CHECK ((type = ANY (ARRAY['note'::text, 'call'::text, 'email'::text, 'meeting'::text, 'follow_up'::text, 'stage_change'::text, 'status_change'::text])))
);


--
-- Name: DealChecklistItem; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DealChecklistItem" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "dealId" text NOT NULL,
    "spaceId" text NOT NULL,
    kind text NOT NULL,
    label text NOT NULL,
    "dueAt" timestamp with time zone,
    "completedAt" timestamp with time zone,
    "position" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: DealContact; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DealContact" (
    "dealId" text NOT NULL,
    "contactId" text NOT NULL,
    role text,
    CONSTRAINT "DealContact_role_check" CHECK (((role IS NULL) OR (role = ANY (ARRAY['buyer'::text, 'seller'::text, 'buyer_agent'::text, 'listing_agent'::text, 'co_agent'::text, 'lender'::text, 'title'::text, 'escrow'::text, 'inspector'::text, 'appraiser'::text, 'attorney'::text, 'other'::text]))))
);


--
-- Name: DealDocument; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DealDocument" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "dealId" text NOT NULL,
    "spaceId" text NOT NULL,
    kind text NOT NULL,
    label text NOT NULL,
    "storagePath" text NOT NULL,
    "contentType" text,
    "sizeBytes" bigint,
    "uploadedById" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "DealDocument_kind_check" CHECK ((kind = ANY (ARRAY['offer'::text, 'counter_offer'::text, 'purchase_agreement'::text, 'inspection_report'::text, 'appraisal'::text, 'loan_estimate'::text, 'closing_disclosure'::text, 'title_commitment'::text, 'photo'::text, 'other'::text])))
);


--
-- Name: DealReviewComment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DealReviewComment" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "reviewRequestId" text NOT NULL,
    "authorUserId" text NOT NULL,
    body text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: DealReviewRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DealReviewRequest" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "dealId" text NOT NULL,
    "requestingUserId" text NOT NULL,
    "companyId" text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    reason text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "resolvedAt" timestamp with time zone,
    "resolvedByUserId" text,
    "resolvedNote" text,
    CONSTRAINT "DealReviewRequest_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'approved'::text, 'closed'::text])))
);


--
-- Name: DealRoutingRule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DealRoutingRule" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "companyId" text NOT NULL,
    name text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "leadType" text,
    "minBudget" numeric(14,2),
    "maxBudget" numeric(14,2),
    "matchTag" text,
    "destinationUserId" text,
    "destinationPoolMethod" text,
    "destinationPoolTag" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "DealRoutingRule_destinationPoolMethod_check" CHECK (("destinationPoolMethod" = ANY (ARRAY['round_robin'::text, 'score_based'::text]))),
    CONSTRAINT deal_routing_rule_budget_range CHECK ((("minBudget" IS NULL) OR ("maxBudget" IS NULL) OR ("maxBudget" >= "minBudget"))),
    CONSTRAINT deal_routing_rule_destination_xor CHECK (((("destinationUserId" IS NOT NULL) AND ("destinationPoolMethod" IS NULL)) OR (("destinationUserId" IS NULL) AND ("destinationPoolMethod" IS NOT NULL))))
);


--
-- Name: DealStage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DealStage" (
    id text NOT NULL,
    "spaceId" text NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#6B7280'::text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "pipelineType" text DEFAULT 'rental'::text,
    "pipelineId" text,
    kind text,
    CONSTRAINT "DealStage_kind_check" CHECK (((kind IS NULL) OR (kind = ANY (ARRAY['lead'::text, 'qualified'::text, 'active'::text, 'under_contract'::text, 'closing'::text, 'closed'::text])))),
    CONSTRAINT "DealStage_pipelineType_check" CHECK (("pipelineType" = ANY (ARRAY['rental'::text, 'buyer'::text, 'seller'::text])))
);

ALTER TABLE ONLY public."DealStage" REPLICA IDENTITY FULL;


--
-- Name: Demo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Demo" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "contactId" text,
    "productProfileId" text,
    "guestName" text NOT NULL,
    "guestEmail" text NOT NULL,
    "guestPhone" text,
    "productAddress" text,
    notes text,
    "startsAt" timestamp with time zone NOT NULL,
    "endsAt" timestamp with time zone NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    "googleEventId" text,
    "manageToken" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "productId" text,
    CONSTRAINT "Demo_status_check" CHECK ((status = ANY (ARRAY['scheduled'::text, 'confirmed'::text, 'completed'::text, 'cancelled'::text, 'no_show'::text])))
);

ALTER TABLE ONLY public."Demo" REPLICA IDENTITY FULL;


--
-- Name: DemoAvailabilityOverride; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DemoAvailabilityOverride" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "productProfileId" text,
    date date NOT NULL,
    "isBlocked" boolean DEFAULT false NOT NULL,
    "startHour" integer,
    "endHour" integer,
    label text,
    recurrence text DEFAULT 'none'::text NOT NULL,
    "endDate" date,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "DemoAvailabilityOverride_recurrence_check" CHECK ((recurrence = ANY (ARRAY['none'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text])))
);


--
-- Name: DemoFeedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DemoFeedback" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "demoId" text NOT NULL,
    "spaceId" text NOT NULL,
    rating integer NOT NULL,
    comment text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "DemoFeedback_rating_check" CHECK (((rating >= 1) AND (rating <= 5)))
);


--
-- Name: DemoProductProfile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DemoProductProfile" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    name text NOT NULL,
    address text,
    "demoDuration" integer DEFAULT 30 NOT NULL,
    "startHour" integer DEFAULT 9 NOT NULL,
    "endHour" integer DEFAULT 17 NOT NULL,
    "daysAvailable" integer[] DEFAULT '{1,2,3,4,5}'::integer[] NOT NULL,
    "bufferMinutes" integer DEFAULT 0 NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: DemoWaitlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DemoWaitlist" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "productProfileId" text,
    "guestName" text NOT NULL,
    "guestEmail" text NOT NULL,
    "guestPhone" text,
    "preferredDate" date NOT NULL,
    notes text,
    status text DEFAULT 'waiting'::text NOT NULL,
    "notifiedAt" timestamp with time zone,
    "expiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "DemoWaitlist_status_check" CHECK ((status = ANY (ARRAY['waiting'::text, 'notified'::text, 'booked'::text, 'expired'::text])))
);


--
-- Name: DisabledSpace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DisabledSpace" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    reason text NOT NULL,
    "disabledBy" text DEFAULT 'system'::text NOT NULL,
    "disabledAt" timestamp with time zone DEFAULT now() NOT NULL,
    "reenabledAt" timestamp with time zone,
    "isActive" boolean DEFAULT true NOT NULL
);


--
-- Name: DocumentEmbedding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DocumentEmbedding" (
    id text NOT NULL,
    "spaceId" text NOT NULL,
    "entityType" text NOT NULL,
    "entityId" text NOT NULL,
    content text NOT NULL,
    embedding public.vector(1536),
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(content, ''::text))) STORED
);


--
-- Name: EmailBroadcast; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."EmailBroadcast" (
    id text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    segment text NOT NULL,
    "recipientCount" integer DEFAULT 0 NOT NULL,
    "sentCount" integer DEFAULT 0 NOT NULL,
    "failedCount" integer DEFAULT 0 NOT NULL,
    "sentBy" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: EmailSuppression; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."EmailSuppression" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    email text NOT NULL,
    "listType" text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "EmailSuppression_listType_check" CHECK (("listType" = ANY (ARRAY['creator_digest'::text, 'seller_digest'::text])))
);


--
-- Name: ExecutionStep; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ExecutionStep" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "taskId" text NOT NULL,
    "spaceId" text NOT NULL,
    "stepIndex" integer DEFAULT 0 NOT NULL,
    "toolName" text NOT NULL,
    "toolArgs" jsonb DEFAULT '{}'::jsonb,
    "toolResult" jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    "inputTokens" integer DEFAULT 0 NOT NULL,
    "outputTokens" integer DEFAULT 0 NOT NULL,
    "costUsd" numeric(10,6) DEFAULT 0 NOT NULL,
    "idempotencyKey" text,
    "errorMessage" text,
    "startedAt" timestamp with time zone,
    "completedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "stepType" text DEFAULT 'tool_call'::text NOT NULL,
    "inputSummary" text,
    "outputSummary" text,
    CONSTRAINT "ExecutionStep_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: File; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."File" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "userId" text NOT NULL,
    "storageKey" text NOT NULL,
    name text NOT NULL,
    "mimeType" text NOT NULL,
    category text NOT NULL,
    "sizeBytes" bigint NOT NULL,
    "isPublic" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "File_sizeBytes_check" CHECK (("sizeBytes" >= 0))
);


--
-- Name: FormAnalyticsEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FormAnalyticsEvent" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "spaceId" text NOT NULL,
    "sessionId" text NOT NULL,
    "formConfigVersion" integer,
    "eventType" text NOT NULL,
    "stepIndex" integer,
    "stepTitle" text,
    "durationMs" integer,
    metadata jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "FormAnalyticsEvent_eventType_check" CHECK (("eventType" = ANY (ARRAY['form_start'::text, 'step_view'::text, 'step_complete'::text, 'form_submit'::text, 'form_abandon'::text])))
);


--
-- Name: FormDraft; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FormDraft" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "spaceId" text NOT NULL,
    email text NOT NULL,
    "resumeToken" text NOT NULL,
    answers jsonb DEFAULT '{}'::jsonb NOT NULL,
    "currentStep" integer DEFAULT 0 NOT NULL,
    "formConfigVersion" integer,
    "expiresAt" timestamp with time zone NOT NULL,
    "completedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: GoalDecomposition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GoalDecomposition" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "taskId" text,
    "goalText" text NOT NULL,
    "decomposedSteps" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "llmModel" text DEFAULT 'gpt-4.1-mini'::text NOT NULL,
    "promptTokens" integer DEFAULT 0 NOT NULL,
    "completionTokens" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: GoogleCalendarToken; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GoogleCalendarToken" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "accessToken" text NOT NULL,
    "refreshToken" text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "calendarId" text DEFAULT 'primary'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: IntegrationConnection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."IntegrationConnection" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "userId" text NOT NULL,
    toolkit text NOT NULL,
    "composioConnectionId" text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    label text,
    "lastError" text,
    "lastUsedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "secretCiphertext" text,
    CONSTRAINT "IntegrationConnection_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text, 'revoked'::text, 'failed'::text])))
);


--
-- Name: IntegrationTrigger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."IntegrationTrigger" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "connectionId" text NOT NULL,
    "composioTriggerId" text,
    "triggerSlug" text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    "lastFiredAt" timestamp with time zone,
    "lastError" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "IntegrationTrigger_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'failed'::text])))
);


--
-- Name: Invitation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Invitation" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "companyId" text NOT NULL,
    email text NOT NULL,
    "roleToAssign" text NOT NULL,
    token text DEFAULT encode(public.gen_random_bytes(32), 'hex'::text) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "expiresAt" timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    "invitedById" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "Invitation_roleToAssign_check" CHECK (("roleToAssign" = ANY (ARRAY['manager_admin'::text, 'seller_member'::text]))),
    CONSTRAINT "Invitation_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'expired'::text, 'cancelled'::text])))
);


--
-- Name: License; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."License" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "orderId" text NOT NULL,
    "productId" text NOT NULL,
    "buyerEmail" text NOT NULL,
    "licenseKey" text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    "deliveredAt" timestamp with time zone DEFAULT now() NOT NULL,
    "expiresAt" timestamp with time zone,
    CONSTRAINT "License_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: ManagerConversation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ManagerConversation" (
    id text NOT NULL,
    "companyId" text NOT NULL,
    title text DEFAULT 'New conversation'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ManagerMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ManagerMessage" (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "conversationId" text NOT NULL,
    role text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    blocks jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ManagerNotification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ManagerNotification" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "companyId" text NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    body text,
    metadata jsonb,
    read boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: MarketplaceOrder; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MarketplaceOrder" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "productId" text NOT NULL,
    "buyerEmail" text NOT NULL,
    "clientUserId" text,
    "amountCents" integer DEFAULT 0 NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "referralCode" text,
    "stripeCheckoutSessionId" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "paidAt" timestamp with time zone,
    "stripeSubscriptionId" text,
    "sellerPayoutCents" integer,
    "sellerTransferId" text,
    "refundedAt" timestamp with time zone,
    "stripePaymentIntentId" text,
    "discountCents" integer DEFAULT 0 NOT NULL,
    "stripeCustomerId" text,
    "platformGmvFeeCents" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "MarketplaceOrder_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'refunded'::text, 'canceled'::text])))
);


--
-- Name: McpApiKey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."McpApiKey" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    name text DEFAULT 'Default'::text NOT NULL,
    "keyHash" text NOT NULL,
    "keyPrefix" text NOT NULL,
    "lastUsedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "clientId" text,
    "clientSecretHash" text,
    "expiresAt" timestamp with time zone
);


--
-- Name: McpAuthCode; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."McpAuthCode" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    code text NOT NULL,
    "clientId" text NOT NULL,
    "spaceId" text NOT NULL,
    "codeChallenge" text NOT NULL,
    "codeChallengeMethod" text DEFAULT 'S256'::text NOT NULL,
    "redirectUri" text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "stateNonce" text,
    "stateHash" text
);


--
-- Name: Message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Message" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "conversationId" text,
    role text NOT NULL,
    content text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    blocks jsonb
);


--
-- Name: MessageTemplate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MessageTemplate" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    name text NOT NULL,
    channel text NOT NULL,
    subject text,
    body text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "sourceTemplateId" text,
    "sourceVersion" integer,
    CONSTRAINT "MessageTemplate_channel_check" CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text, 'note'::text])))
);


--
-- Name: Note; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Note" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    title text DEFAULT 'Untitled'::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    icon text,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: Pipeline; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Pipeline" (
    id text NOT NULL,
    "spaceId" text NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#6366f1'::text NOT NULL,
    emoji text,
    "position" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: Product; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Product" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    address text,
    "unitNumber" text,
    city text,
    "stateRegion" text,
    "postalCode" text,
    "mlsNumber" text,
    "productType" text,
    beds numeric(4,1),
    baths numeric(4,1),
    "squareFeet" integer,
    "lotSizeSqft" integer,
    "yearBuilt" integer,
    "listPrice" numeric(14,2),
    "listingStatus" text DEFAULT 'draft'::text NOT NULL,
    "listingUrl" text,
    photos jsonb DEFAULT '[]'::jsonb NOT NULL,
    notes text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "companyId" text,
    "assignedSpaceId" text,
    name text,
    tagline text,
    "longDescription" text,
    category text,
    "pricingModel" text DEFAULT 'one_time'::text NOT NULL,
    "priceCents" integer,
    currency text DEFAULT 'usd'::text NOT NULL,
    "billingPeriod" text,
    features jsonb DEFAULT '[]'::jsonb NOT NULL,
    "logoUrl" text,
    "websiteUrl" text,
    published boolean DEFAULT false NOT NULL,
    "marketplaceSlug" text,
    "commissionType" text,
    "commissionValue" numeric,
    featured boolean DEFAULT false NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    CONSTRAINT "Product_billingPeriod_check" CHECK ((("billingPeriod" IS NULL) OR ("billingPeriod" = ANY (ARRAY['monthly'::text, 'yearly'::text])))),
    CONSTRAINT "Product_commissionType_check" CHECK ((("commissionType" IS NULL) OR ("commissionType" = ANY (ARRAY['percent'::text, 'flat'::text])))),
    CONSTRAINT "Product_pricingModel_check" CHECK (("pricingModel" = ANY (ARRAY['one_time'::text, 'subscription'::text])))
);


--
-- Name: ProductPacket; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProductPacket" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "productId" text NOT NULL,
    name text NOT NULL,
    token text NOT NULL,
    "includeDocumentIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "expiresAt" timestamp with time zone,
    "viewCount" integer DEFAULT 0 NOT NULL,
    "lastViewedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "revokedAt" timestamp with time zone
);


--
-- Name: ProductView; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProductView" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text,
    "productId" text NOT NULL,
    "visitorId" text,
    "ipHash" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ProfilePage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProfilePage" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    headline text,
    "showIntake" boolean DEFAULT true NOT NULL,
    "showDemos" boolean DEFAULT true NOT NULL,
    "showProducts" boolean DEFAULT true NOT NULL,
    "customLinks" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    videos jsonb DEFAULT '[]'::jsonb NOT NULL,
    "coverPhotoUrl" text,
    "profilePhotoUrl" text,
    "featuredProductIds" text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: PushSubscription; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PushSubscription" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "userId" text,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    "userAgent" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: Referral; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Referral" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "linkId" text NOT NULL,
    "partnerId" text NOT NULL,
    "buyerEmail" text NOT NULL,
    "orderId" text,
    status text DEFAULT 'lead'::text NOT NULL,
    "firstClickAt" timestamp with time zone,
    "convertedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "Referral_status_check" CHECK ((status = ANY (ARRAY['lead'::text, 'customer'::text])))
);


--
-- Name: ReferralClick; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ReferralClick" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "linkId" text NOT NULL,
    "visitorId" text,
    "ipHash" text,
    "userAgent" text,
    "landingUrl" text,
    referrer text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ReferralLink; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ReferralLink" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "partnerId" text NOT NULL,
    "programId" text NOT NULL,
    code text NOT NULL,
    "destinationUrl" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "productId" text,
    "discountPercent" integer DEFAULT 0 NOT NULL,
    "isVanity" boolean DEFAULT false NOT NULL,
    CONSTRAINT "ReferralLink_discountPercent_check" CHECK ((("discountPercent" >= 0) AND ("discountPercent" <= 90)))
);


--
-- Name: RefundRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."RefundRequest" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "orderId" text NOT NULL,
    "spaceId" text NOT NULL,
    "buyerEmail" text NOT NULL,
    reason text,
    status text DEFAULT 'requested'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "resolvedAt" timestamp with time zone,
    CONSTRAINT "RefundRequest_status_check" CHECK ((status = ANY (ARRAY['requested'::text, 'approved'::text, 'declined'::text])))
);


--
-- Name: Review; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Review" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "productId" text NOT NULL,
    "buyerEmail" text NOT NULL,
    rating integer NOT NULL,
    title text,
    body text,
    status text DEFAULT 'published'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "Review_rating_check" CHECK (((rating >= 1) AND (rating <= 5))),
    CONSTRAINT "Review_status_check" CHECK ((status = ANY (ARRAY['published'::text, 'hidden'::text])))
);


--
-- Name: Routine; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Routine" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    instruction text NOT NULL,
    cadence text DEFAULT 'daily'::text NOT NULL,
    hour integer DEFAULT 13 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "lastRunAt" timestamp with time zone,
    "lastRunStatus" text,
    "nextRunAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "dayOfMonth" integer,
    "daysOfWeek" text[],
    CONSTRAINT "Routine_cadence_check" CHECK ((cadence = ANY (ARRAY['hourly'::text, 'daily'::text, 'weekdays'::text, 'monthly'::text, 'custom'::text]))),
    CONSTRAINT "Routine_cadence_fields_check" CHECK ((((cadence = 'monthly'::text) AND ("dayOfMonth" IS NOT NULL) AND ("daysOfWeek" IS NULL)) OR ((cadence = 'custom'::text) AND ("daysOfWeek" IS NOT NULL) AND ("dayOfMonth" IS NULL)) OR ((cadence = ANY (ARRAY['hourly'::text, 'daily'::text, 'weekdays'::text])) AND ("dayOfMonth" IS NULL) AND ("daysOfWeek" IS NULL)))),
    CONSTRAINT "Routine_dayOfMonth_check" CHECK ((("dayOfMonth" IS NULL) OR (("dayOfMonth" >= 1) AND ("dayOfMonth" <= 28)))),
    CONSTRAINT "Routine_daysOfWeek_check" CHECK ((("daysOfWeek" IS NULL) OR ((array_length("daysOfWeek", 1) > 0) AND ("daysOfWeek" <@ ARRAY['mon'::text, 'tue'::text, 'wed'::text, 'thu'::text, 'fri'::text, 'sat'::text, 'sun'::text])))),
    CONSTRAINT "Routine_hour_check" CHECK (((hour >= 0) AND (hour <= 23))),
    CONSTRAINT "Routine_lastRunStatus_check" CHECK (("lastRunStatus" = ANY (ARRAY['ok'::text, 'error'::text])))
);


--
-- Name: SignatureRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SignatureRequest" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "dealId" text,
    "documentId" text,
    "envelopeId" text,
    subject text NOT NULL,
    "signerEmail" text NOT NULL,
    "signerName" text,
    status text DEFAULT 'created'::text NOT NULL,
    "signedDocumentUrl" text,
    "completedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "contactId" text,
    CONSTRAINT "SignatureRequest_status_check" CHECK ((status = ANY (ARRAY['created'::text, 'sent'::text, 'delivered'::text, 'completed'::text, 'declined'::text, 'voided'::text])))
);


--
-- Name: Space; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Space" (
    id text NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    emoji text DEFAULT '🏠'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "ownerId" text NOT NULL,
    "companyId" text,
    "stripeCustomerId" text,
    "stripeSubscriptionId" text,
    "stripeSubscriptionStatus" text DEFAULT 'inactive'::text NOT NULL,
    "stripePeriodEnd" timestamp with time zone,
    "trialUsedAt" timestamp with time zone,
    "stripeConnectAccountId" text,
    "marketplaceFeeBps" integer,
    plan text DEFAULT 'free'::text NOT NULL,
    "planActivatedAt" timestamp with time zone,
    CONSTRAINT "Space_plan_check" CHECK ((plan = ANY (ARRAY['free'::text, 'solo'::text, 'pro'::text]))),
    CONSTRAINT "Space_stripeSubscriptionStatus_check" CHECK (("stripeSubscriptionStatus" = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text, 'canceled'::text, 'unpaid'::text, 'inactive'::text])))
);


--
-- Name: SpaceSetting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SpaceSetting" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    notifications boolean DEFAULT true NOT NULL,
    "smsNotifications" boolean DEFAULT false NOT NULL,
    "notifyNewLeads" boolean DEFAULT true NOT NULL,
    "notifyDemoBookings" boolean DEFAULT true NOT NULL,
    "notifyNewDeals" boolean DEFAULT true NOT NULL,
    "notifyFollowUps" boolean DEFAULT true NOT NULL,
    timezone text DEFAULT 'America/New_York'::text NOT NULL,
    "phoneNumber" text,
    "myConnections" text,
    "aiPersonalization" text,
    "billingSettings" text,
    "businessName" text,
    "intakePageTitle" text,
    "intakePageIntro" text,
    bio text,
    "socialLinks" jsonb DEFAULT '{}'::jsonb,
    "intakeAccentColor" text DEFAULT '#ff964f'::text,
    "intakeBorderRadius" text DEFAULT 'rounded'::text,
    "intakeFont" text DEFAULT 'system'::text,
    "intakeFooterLinks" jsonb DEFAULT '[]'::jsonb,
    "demoDuration" integer DEFAULT 30 NOT NULL,
    "demoStartHour" integer DEFAULT 9 NOT NULL,
    "demoEndHour" integer DEFAULT 17 NOT NULL,
    "demoDaysAvailable" integer[] DEFAULT '{1,2,3,4,5}'::integer[] NOT NULL,
    "demoBookingPageTitle" text,
    "demoBookingPageIntro" text,
    "demoBufferMinutes" integer DEFAULT 0 NOT NULL,
    "demoBlockedDates" text[] DEFAULT '{}'::text[] NOT NULL,
    "privacyPolicyUrl" text,
    "consentCheckboxLabel" text,
    "formConfig" jsonb,
    "rentalFormConfig" jsonb,
    "buyerFormConfig" jsonb,
    "formConfigSource" text DEFAULT 'legacy'::text NOT NULL,
    "rentalScoringModel" jsonb,
    "buyerScoringModel" jsonb,
    "trackingPixels" jsonb,
    "privacyPolicyHtml" text,
    "isVerified" boolean DEFAULT false NOT NULL,
    "logoUrl" text,
    "sellerPhotoUrl" text,
    "intakeHeaderBgColor" text,
    "intakeHeaderGradient" text,
    "intakeDarkMode" boolean DEFAULT false NOT NULL,
    "intakeFaviconUrl" text,
    "intakeThankYouTitle" text,
    "intakeThankYouMessage" text,
    "intakeConfirmationEmail" text,
    "intakeVideoUrl" text,
    "intakeDisclaimerText" text,
    "intakeDisabledSteps" text[] DEFAULT '{}'::text[],
    "intakeRequiredFields" text[] DEFAULT '{}'::text[],
    "intakeCustomQuestions" jsonb DEFAULT '[]'::jsonb,
    "intakeStepOrder" text[] DEFAULT '{}'::text[],
    "intakeLicenseNumber" text,
    "intakeFairHousingNotice" text,
    "intakeShowEqualHousingMark" boolean DEFAULT false NOT NULL,
    "briefEnabled" boolean DEFAULT true NOT NULL,
    "briefHour" integer DEFAULT 7 NOT NULL,
    "briefIntroSeenAt" timestamp with time zone,
    "briefEnabledAt" timestamp with time zone,
    "briefEmail" boolean DEFAULT false NOT NULL,
    "briefSms" boolean DEFAULT false NOT NULL,
    "unsubscribeToken" text DEFAULT encode(public.gen_random_bytes(16), 'hex'::text),
    "notifyPush" boolean DEFAULT true NOT NULL,
    CONSTRAINT "SpaceSetting_briefHour_check" CHECK ((("briefHour" >= 0) AND ("briefHour" <= 23))),
    CONSTRAINT "SpaceSetting_formConfigSource_check" CHECK (("formConfigSource" = ANY (ARRAY['custom'::text, 'company'::text, 'legacy'::text]))),
    CONSTRAINT "SpaceSetting_intakeBorderRadius_check" CHECK (("intakeBorderRadius" = ANY (ARRAY['rounded'::text, 'sharp'::text]))),
    CONSTRAINT "SpaceSetting_intakeFont_check" CHECK (("intakeFont" = ANY (ARRAY['system'::text, 'serif'::text, 'mono'::text])))
);


--
-- Name: COLUMN "SpaceSetting"."rentalScoringModel"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."SpaceSetting"."rentalScoringModel" IS 'AI-generated scoring model for rental intake form. JSON matches ScoringModel type.';


--
-- Name: COLUMN "SpaceSetting"."buyerScoringModel"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public."SpaceSetting"."buyerScoringModel" IS 'AI-generated scoring model for buyer intake form. JSON matches ScoringModel type.';


--
-- Name: StripeBridge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."StripeBridge" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "webhookSecretEnc" text,
    "lastEventAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: StudioBrand; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."StudioBrand" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "logoFileId" text,
    "headshotFileId" text,
    colors text[] DEFAULT '{}'::text[] NOT NULL,
    fonts jsonb DEFAULT '{}'::jsonb NOT NULL,
    handles jsonb DEFAULT '{}'::jsonb NOT NULL,
    voice text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: StudioGeneration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."StudioGeneration" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "userId" text NOT NULL,
    "fileId" text,
    "sourceFileId" text,
    kind text NOT NULL,
    model text NOT NULL,
    prompt text,
    status text DEFAULT 'pending'::text NOT NULL,
    "costUsd" numeric(10,6) DEFAULT 0 NOT NULL,
    "falRequestId" text,
    "errorMessage" text,
    "completedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "StudioGeneration_kind_check" CHECK ((kind = ANY (ARRAY['image'::text, 'video'::text]))),
    CONSTRAINT "StudioGeneration_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: StudioPost; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."StudioPost" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    "userId" text NOT NULL,
    "fileId" text NOT NULL,
    caption text DEFAULT ''::text NOT NULL,
    platforms text[] DEFAULT '{}'::text[] NOT NULL,
    "scheduledAt" timestamp with time zone NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    "platformResults" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "inngestEventId" text,
    "postedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "StudioPost_status_check" CHECK ((status = ANY (ARRAY['scheduled'::text, 'publishing'::text, 'posted'::text, 'failed'::text, 'canceled'::text])))
);


--
-- Name: SupportTicket; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SupportTicket" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text,
    "userId" text NOT NULL,
    email text NOT NULL,
    name text,
    subject text NOT NULL,
    message text NOT NULL,
    category text DEFAULT 'other'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    "adminNote" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "SupportTicket_category_check" CHECK ((category = ANY (ARRAY['bug'::text, 'question'::text, 'billing'::text, 'feature'::text, 'other'::text]))),
    CONSTRAINT "SupportTicket_priority_check" CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text]))),
    CONSTRAINT "SupportTicket_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text, 'closed'::text])))
);


--
-- Name: SwarmEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SwarmEvent" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "swarmRunId" text NOT NULL,
    "memberId" text,
    type text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: SwarmMember; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SwarmMember" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "swarmRunId" text NOT NULL,
    "customAgentId" text,
    name text NOT NULL,
    role text,
    "systemPrompt" text DEFAULT ''::text NOT NULL,
    task text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    output text,
    wave integer DEFAULT 1 NOT NULL,
    "costCents" integer DEFAULT 0 NOT NULL,
    "startedAt" timestamp with time zone,
    "completedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "SwarmMember_status_check" CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: SwarmRun; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SwarmRun" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "spaceId" text NOT NULL,
    goal text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    plan jsonb,
    result text,
    "errorMessage" text,
    "totalCostCents" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "completedAt" timestamp with time zone,
    CONSTRAINT "SwarmRun_status_check" CHECK ((status = ANY (ARRAY['queued'::text, 'planning'::text, 'running'::text, 'auditing'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: TaskCheckpoint; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."TaskCheckpoint" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "taskId" text NOT NULL,
    "spaceId" text NOT NULL,
    "checkpointData" jsonb NOT NULL,
    "stepIndex" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TaskDependency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."TaskDependency" (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "taskId" text NOT NULL,
    "dependsOnTaskId" text NOT NULL,
    "dependencyType" text DEFAULT 'sequential'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "TaskDependency_check" CHECK (("taskId" <> "dependsOnTaskId")),
    CONSTRAINT "TaskDependency_dependencyType_check" CHECK (("dependencyType" = ANY (ARRAY['sequential'::text, 'data'::text, 'soft'::text])))
);


--
-- Name: TelemetryEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."TelemetryEvent" (
    id text NOT NULL,
    "spaceId" text,
    "userId" text,
    event text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: User; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."User" (
    id text NOT NULL,
    "clerkId" text NOT NULL,
    email text NOT NULL,
    name text,
    avatar text,
    bio text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "onboardingCurrentStep" integer DEFAULT 0 NOT NULL,
    "onboardingStartedAt" timestamp with time zone,
    "onboardingCompletedAt" timestamp with time zone,
    onboard boolean DEFAULT false NOT NULL,
    "platformRole" text DEFAULT 'user'::text NOT NULL,
    "accountType" text DEFAULT 'seller'::text NOT NULL,
    phone text,
    "socialLinks" jsonb DEFAULT '{}'::jsonb,
    "websiteUrl" text,
    "mlsId" text,
    "companyAffiliation" text,
    "preferredNotification" text DEFAULT 'email'::text,
    timezone text DEFAULT 'America/New_York'::text,
    "referralSource" text,
    "biggestPainPoint" text,
    status text DEFAULT 'active'::text NOT NULL,
    "offboardedAt" timestamp with time zone,
    "offboardedToUserId" text,
    CONSTRAINT "User_accountType_check" CHECK (("accountType" = ANY (ARRAY['seller'::text, 'manager_only'::text, 'both'::text]))),
    CONSTRAINT "User_platformRole_check" CHECK (("platformRole" = ANY (ARRAY['user'::text, 'admin'::text, 'banned'::text]))),
    CONSTRAINT "User_preferredNotification_check" CHECK (("preferredNotification" = ANY (ARRAY['email'::text, 'sms'::text, 'both'::text]))),
    CONSTRAINT "User_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'offboarded'::text])))
);


--
-- Name: AIUserProfile AIUserProfile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AIUserProfile"
    ADD CONSTRAINT "AIUserProfile_pkey" PRIMARY KEY (id);


--
-- Name: AIUserProfile AIUserProfile_spaceId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AIUserProfile"
    ADD CONSTRAINT "AIUserProfile_spaceId_key" UNIQUE ("spaceId");


--
-- Name: AffiliateAccount AffiliateAccount_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliateAccount"
    ADD CONSTRAINT "AffiliateAccount_pkey" PRIMARY KEY (id);


--
-- Name: AffiliateAccount AffiliateAccount_spaceId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliateAccount"
    ADD CONSTRAINT "AffiliateAccount_spaceId_key" UNIQUE ("spaceId");


--
-- Name: AffiliateCommission AffiliateCommission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliateCommission"
    ADD CONSTRAINT "AffiliateCommission_pkey" PRIMARY KEY (id);


--
-- Name: AffiliatePartner AffiliatePartner_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliatePartner"
    ADD CONSTRAINT "AffiliatePartner_pkey" PRIMARY KEY (id);


--
-- Name: AffiliatePayout AffiliatePayout_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliatePayout"
    ADD CONSTRAINT "AffiliatePayout_pkey" PRIMARY KEY (id);


--
-- Name: AffiliateProgram AffiliateProgram_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliateProgram"
    ADD CONSTRAINT "AffiliateProgram_pkey" PRIMARY KEY (id);


--
-- Name: AgentActivityLog AgentActivityLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentActivityLog"
    ADD CONSTRAINT "AgentActivityLog_pkey" PRIMARY KEY (id);


--
-- Name: AgentDraft AgentDraft_idempotencyKey_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentDraft"
    ADD CONSTRAINT "AgentDraft_idempotencyKey_key" UNIQUE ("idempotencyKey");


--
-- Name: AgentDraft AgentDraft_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentDraft"
    ADD CONSTRAINT "AgentDraft_pkey" PRIMARY KEY (id);


--
-- Name: AgentGoal AgentGoal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentGoal"
    ADD CONSTRAINT "AgentGoal_pkey" PRIMARY KEY (id);


--
-- Name: AgentMemory AgentMemory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentMemory"
    ADD CONSTRAINT "AgentMemory_pkey" PRIMARY KEY (id);


--
-- Name: AgentPausedRun AgentPausedRun_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentPausedRun"
    ADD CONSTRAINT "AgentPausedRun_pkey" PRIMARY KEY (id);


--
-- Name: AgentQuestion AgentQuestion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentQuestion"
    ADD CONSTRAINT "AgentQuestion_pkey" PRIMARY KEY (id);


--
-- Name: AgentSettings AgentSettings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentSettings"
    ADD CONSTRAINT "AgentSettings_pkey" PRIMARY KEY (id);


--
-- Name: AgentSettings AgentSettings_spaceId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentSettings"
    ADD CONSTRAINT "AgentSettings_spaceId_key" UNIQUE ("spaceId");


--
-- Name: AgentTask AgentTask_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentTask"
    ADD CONSTRAINT "AgentTask_pkey" PRIMARY KEY (id);


--
-- Name: AgentTrajectory AgentTrajectory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentTrajectory"
    ADD CONSTRAINT "AgentTrajectory_pkey" PRIMARY KEY (id);


--
-- Name: AgentTrajectory AgentTrajectory_runId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentTrajectory"
    ADD CONSTRAINT "AgentTrajectory_runId_key" UNIQUE ("runId");


--
-- Name: AnnouncementDismissal AnnouncementDismissal_announcementId_userId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AnnouncementDismissal"
    ADD CONSTRAINT "AnnouncementDismissal_announcementId_userId_key" UNIQUE ("announcementId", "userId");


--
-- Name: AnnouncementDismissal AnnouncementDismissal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AnnouncementDismissal"
    ADD CONSTRAINT "AnnouncementDismissal_pkey" PRIMARY KEY (id);


--
-- Name: Announcement Announcement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Announcement"
    ADD CONSTRAINT "Announcement_pkey" PRIMARY KEY (id);


--
-- Name: AppKnowledgeDoc AppKnowledgeDoc_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AppKnowledgeDoc"
    ADD CONSTRAINT "AppKnowledgeDoc_pkey" PRIMARY KEY (id);


--
-- Name: ApplicationMessage ApplicationMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ApplicationMessage"
    ADD CONSTRAINT "ApplicationMessage_pkey" PRIMARY KEY (id);


--
-- Name: ApplicationStatusUpdate ApplicationStatusUpdate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ApplicationStatusUpdate"
    ADD CONSTRAINT "ApplicationStatusUpdate_pkey" PRIMARY KEY (id);


--
-- Name: ArtifactVersion ArtifactVersion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ArtifactVersion"
    ADD CONSTRAINT "ArtifactVersion_pkey" PRIMARY KEY (id);


--
-- Name: Artifact Artifact_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Artifact"
    ADD CONSTRAINT "Artifact_pkey" PRIMARY KEY (id);


--
-- Name: Attachment Attachment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Attachment"
    ADD CONSTRAINT "Attachment_pkey" PRIMARY KEY (id);


--
-- Name: AuditLog AuditLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_pkey" PRIMARY KEY (id);


--
-- Name: BriefTipHistory BriefTipHistory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BriefTipHistory"
    ADD CONSTRAINT "BriefTipHistory_pkey" PRIMARY KEY (id);


--
-- Name: Brief Brief_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Brief"
    ADD CONSTRAINT "Brief_pkey" PRIMARY KEY (id);


--
-- Name: CalendarEventMirror CalendarEventMirror_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CalendarEventMirror"
    ADD CONSTRAINT "CalendarEventMirror_pkey" PRIMARY KEY (id);


--
-- Name: CalendarEvent CalendarEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CalendarEvent"
    ADD CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY (id);


--
-- Name: CalendarNote CalendarNote_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CalendarNote"
    ADD CONSTRAINT "CalendarNote_pkey" PRIMARY KEY (id);


--
-- Name: CallLog CallLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CallLog"
    ADD CONSTRAINT "CallLog_pkey" PRIMARY KEY (id);


--
-- Name: ChatUsage ChatUsage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChatUsage"
    ADD CONSTRAINT "ChatUsage_pkey" PRIMARY KEY (id);


--
-- Name: ClientAuthCode ClientAuthCode_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientAuthCode"
    ADD CONSTRAINT "ClientAuthCode_pkey" PRIMARY KEY (id);


--
-- Name: ClientDocument ClientDocument_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientDocument"
    ADD CONSTRAINT "ClientDocument_pkey" PRIMARY KEY (id);


--
-- Name: ClientInfoRequest ClientInfoRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientInfoRequest"
    ADD CONSTRAINT "ClientInfoRequest_pkey" PRIMARY KEY (id);


--
-- Name: ClientMessage ClientMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientMessage"
    ADD CONSTRAINT "ClientMessage_pkey" PRIMARY KEY (id);


--
-- Name: ClientUser ClientUser_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientUser"
    ADD CONSTRAINT "ClientUser_pkey" PRIMARY KEY (id);


--
-- Name: CmaReport CmaReport_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CmaReport"
    ADD CONSTRAINT "CmaReport_pkey" PRIMARY KEY (id);


--
-- Name: CommissionLedger CommissionLedger_dealId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CommissionLedger"
    ADD CONSTRAINT "CommissionLedger_dealId_key" UNIQUE ("dealId");


--
-- Name: CommissionLedger CommissionLedger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CommissionLedger"
    ADD CONSTRAINT "CommissionLedger_pkey" PRIMARY KEY (id);


--
-- Name: CommissionSplit CommissionSplit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CommissionSplit"
    ADD CONSTRAINT "CommissionSplit_pkey" PRIMARY KEY (id);


--
-- Name: CompanyIntegrationConnection CompanyIntegrationConnection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyIntegrationConnection"
    ADD CONSTRAINT "CompanyIntegrationConnection_pkey" PRIMARY KEY (id);


--
-- Name: CompanyMembership CompanyMembership_companyId_userId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyMembership"
    ADD CONSTRAINT "CompanyMembership_companyId_userId_key" UNIQUE ("companyId", "userId");


--
-- Name: CompanyMembership CompanyMembership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyMembership"
    ADD CONSTRAINT "CompanyMembership_pkey" PRIMARY KEY (id);


--
-- Name: CompanyRemoval CompanyRemoval_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyRemoval"
    ADD CONSTRAINT "CompanyRemoval_pkey" PRIMARY KEY ("companyId", "userId");


--
-- Name: CompanyTemplate CompanyTemplate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyTemplate"
    ADD CONSTRAINT "CompanyTemplate_pkey" PRIMARY KEY (id);


--
-- Name: Company Company_joinCode_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Company"
    ADD CONSTRAINT "Company_joinCode_key" UNIQUE ("joinCode");


--
-- Name: Company Company_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Company"
    ADD CONSTRAINT "Company_pkey" PRIMARY KEY (id);


--
-- Name: ContactDocument ContactDocument_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ContactDocument"
    ADD CONSTRAINT "ContactDocument_pkey" PRIMARY KEY (id);


--
-- Name: Contact Contact_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Contact"
    ADD CONSTRAINT "Contact_pkey" PRIMARY KEY (id);


--
-- Name: Contact Contact_statusPortalToken_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Contact"
    ADD CONSTRAINT "Contact_statusPortalToken_key" UNIQUE ("statusPortalToken");


--
-- Name: Conversation Conversation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Conversation"
    ADD CONSTRAINT "Conversation_pkey" PRIMARY KEY (id);


--
-- Name: CreatorProfile CreatorProfile_emailLower_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CreatorProfile"
    ADD CONSTRAINT "CreatorProfile_emailLower_key" UNIQUE ("emailLower");


--
-- Name: CreatorProfile CreatorProfile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CreatorProfile"
    ADD CONSTRAINT "CreatorProfile_pkey" PRIMARY KEY (id);


--
-- Name: CreditLot CreditLot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CreditLot"
    ADD CONSTRAINT "CreditLot_pkey" PRIMARY KEY (id);


--
-- Name: CreditTxn CreditTxn_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CreditTxn"
    ADD CONSTRAINT "CreditTxn_pkey" PRIMARY KEY (id);


--
-- Name: CustomAgent CustomAgent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CustomAgent"
    ADD CONSTRAINT "CustomAgent_pkey" PRIMARY KEY (id);


--
-- Name: DeadLetterEvent DeadLetterEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DeadLetterEvent"
    ADD CONSTRAINT "DeadLetterEvent_pkey" PRIMARY KEY (id);


--
-- Name: DealActivity DealActivity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealActivity"
    ADD CONSTRAINT "DealActivity_pkey" PRIMARY KEY (id);


--
-- Name: DealChecklistItem DealChecklistItem_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealChecklistItem"
    ADD CONSTRAINT "DealChecklistItem_pkey" PRIMARY KEY (id);


--
-- Name: DealContact DealContact_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealContact"
    ADD CONSTRAINT "DealContact_pkey" PRIMARY KEY ("dealId", "contactId");


--
-- Name: DealDocument DealDocument_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealDocument"
    ADD CONSTRAINT "DealDocument_pkey" PRIMARY KEY (id);


--
-- Name: DealReviewComment DealReviewComment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealReviewComment"
    ADD CONSTRAINT "DealReviewComment_pkey" PRIMARY KEY (id);


--
-- Name: DealReviewRequest DealReviewRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealReviewRequest"
    ADD CONSTRAINT "DealReviewRequest_pkey" PRIMARY KEY (id);


--
-- Name: DealRoutingRule DealRoutingRule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealRoutingRule"
    ADD CONSTRAINT "DealRoutingRule_pkey" PRIMARY KEY (id);


--
-- Name: DealStage DealStage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealStage"
    ADD CONSTRAINT "DealStage_pkey" PRIMARY KEY (id);


--
-- Name: Deal Deal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Deal"
    ADD CONSTRAINT "Deal_pkey" PRIMARY KEY (id);


--
-- Name: DemoAvailabilityOverride DemoAvailabilityOverride_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DemoAvailabilityOverride"
    ADD CONSTRAINT "DemoAvailabilityOverride_pkey" PRIMARY KEY (id);


--
-- Name: DemoFeedback DemoFeedback_demoId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DemoFeedback"
    ADD CONSTRAINT "DemoFeedback_demoId_key" UNIQUE ("demoId");


--
-- Name: DemoFeedback DemoFeedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DemoFeedback"
    ADD CONSTRAINT "DemoFeedback_pkey" PRIMARY KEY (id);


--
-- Name: DemoProductProfile DemoProductProfile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DemoProductProfile"
    ADD CONSTRAINT "DemoProductProfile_pkey" PRIMARY KEY (id);


--
-- Name: DemoWaitlist DemoWaitlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DemoWaitlist"
    ADD CONSTRAINT "DemoWaitlist_pkey" PRIMARY KEY (id);


--
-- Name: Demo Demo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Demo"
    ADD CONSTRAINT "Demo_pkey" PRIMARY KEY (id);


--
-- Name: DisabledSpace DisabledSpace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DisabledSpace"
    ADD CONSTRAINT "DisabledSpace_pkey" PRIMARY KEY (id);


--
-- Name: DocumentEmbedding DocumentEmbedding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DocumentEmbedding"
    ADD CONSTRAINT "DocumentEmbedding_pkey" PRIMARY KEY (id);


--
-- Name: EmailBroadcast EmailBroadcast_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."EmailBroadcast"
    ADD CONSTRAINT "EmailBroadcast_pkey" PRIMARY KEY (id);


--
-- Name: EmailSuppression EmailSuppression_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."EmailSuppression"
    ADD CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY (id);


--
-- Name: ExecutionStep ExecutionStep_idempotencyKey_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ExecutionStep"
    ADD CONSTRAINT "ExecutionStep_idempotencyKey_key" UNIQUE ("idempotencyKey");


--
-- Name: ExecutionStep ExecutionStep_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ExecutionStep"
    ADD CONSTRAINT "ExecutionStep_pkey" PRIMARY KEY (id);


--
-- Name: File File_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."File"
    ADD CONSTRAINT "File_pkey" PRIMARY KEY (id);


--
-- Name: File File_storageKey_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."File"
    ADD CONSTRAINT "File_storageKey_key" UNIQUE ("storageKey");


--
-- Name: FormAnalyticsEvent FormAnalyticsEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FormAnalyticsEvent"
    ADD CONSTRAINT "FormAnalyticsEvent_pkey" PRIMARY KEY (id);


--
-- Name: FormDraft FormDraft_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FormDraft"
    ADD CONSTRAINT "FormDraft_pkey" PRIMARY KEY (id);


--
-- Name: FormDraft FormDraft_resumeToken_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FormDraft"
    ADD CONSTRAINT "FormDraft_resumeToken_key" UNIQUE ("resumeToken");


--
-- Name: GoalDecomposition GoalDecomposition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GoalDecomposition"
    ADD CONSTRAINT "GoalDecomposition_pkey" PRIMARY KEY (id);


--
-- Name: GoogleCalendarToken GoogleCalendarToken_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GoogleCalendarToken"
    ADD CONSTRAINT "GoogleCalendarToken_pkey" PRIMARY KEY (id);


--
-- Name: GoogleCalendarToken GoogleCalendarToken_spaceId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GoogleCalendarToken"
    ADD CONSTRAINT "GoogleCalendarToken_spaceId_key" UNIQUE ("spaceId");


--
-- Name: IntegrationConnection IntegrationConnection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IntegrationConnection"
    ADD CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY (id);


--
-- Name: IntegrationTrigger IntegrationTrigger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IntegrationTrigger"
    ADD CONSTRAINT "IntegrationTrigger_pkey" PRIMARY KEY (id);


--
-- Name: Invitation Invitation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Invitation"
    ADD CONSTRAINT "Invitation_pkey" PRIMARY KEY (id);


--
-- Name: Invitation Invitation_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Invitation"
    ADD CONSTRAINT "Invitation_token_key" UNIQUE (token);


--
-- Name: License License_licenseKey_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."License"
    ADD CONSTRAINT "License_licenseKey_key" UNIQUE ("licenseKey");


--
-- Name: License License_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."License"
    ADD CONSTRAINT "License_pkey" PRIMARY KEY (id);


--
-- Name: ManagerConversation ManagerConversation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ManagerConversation"
    ADD CONSTRAINT "ManagerConversation_pkey" PRIMARY KEY (id);


--
-- Name: ManagerMessage ManagerMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ManagerMessage"
    ADD CONSTRAINT "ManagerMessage_pkey" PRIMARY KEY (id);


--
-- Name: ManagerNotification ManagerNotification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ManagerNotification"
    ADD CONSTRAINT "ManagerNotification_pkey" PRIMARY KEY (id);


--
-- Name: MarketplaceOrder MarketplaceOrder_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MarketplaceOrder"
    ADD CONSTRAINT "MarketplaceOrder_pkey" PRIMARY KEY (id);


--
-- Name: McpApiKey McpApiKey_clientId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."McpApiKey"
    ADD CONSTRAINT "McpApiKey_clientId_key" UNIQUE ("clientId");


--
-- Name: McpApiKey McpApiKey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."McpApiKey"
    ADD CONSTRAINT "McpApiKey_pkey" PRIMARY KEY (id);


--
-- Name: McpAuthCode McpAuthCode_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."McpAuthCode"
    ADD CONSTRAINT "McpAuthCode_code_key" UNIQUE (code);


--
-- Name: McpAuthCode McpAuthCode_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."McpAuthCode"
    ADD CONSTRAINT "McpAuthCode_pkey" PRIMARY KEY (id);


--
-- Name: MessageTemplate MessageTemplate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageTemplate"
    ADD CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY (id);


--
-- Name: Message Message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_pkey" PRIMARY KEY (id);


--
-- Name: Note Note_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Note"
    ADD CONSTRAINT "Note_pkey" PRIMARY KEY (id);


--
-- Name: Pipeline Pipeline_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Pipeline"
    ADD CONSTRAINT "Pipeline_pkey" PRIMARY KEY (id);


--
-- Name: ProductPacket ProductPacket_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductPacket"
    ADD CONSTRAINT "ProductPacket_pkey" PRIMARY KEY (id);


--
-- Name: ProductPacket ProductPacket_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductPacket"
    ADD CONSTRAINT "ProductPacket_token_key" UNIQUE (token);


--
-- Name: ProductView ProductView_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductView"
    ADD CONSTRAINT "ProductView_pkey" PRIMARY KEY (id);


--
-- Name: Product Product_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_pkey" PRIMARY KEY (id);


--
-- Name: ProfilePage ProfilePage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfilePage"
    ADD CONSTRAINT "ProfilePage_pkey" PRIMARY KEY (id);


--
-- Name: ProfilePage ProfilePage_spaceId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfilePage"
    ADD CONSTRAINT "ProfilePage_spaceId_key" UNIQUE ("spaceId");


--
-- Name: PushSubscription PushSubscription_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PushSubscription"
    ADD CONSTRAINT "PushSubscription_endpoint_key" UNIQUE (endpoint);


--
-- Name: PushSubscription PushSubscription_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PushSubscription"
    ADD CONSTRAINT "PushSubscription_pkey" PRIMARY KEY (id);


--
-- Name: ReferralClick ReferralClick_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReferralClick"
    ADD CONSTRAINT "ReferralClick_pkey" PRIMARY KEY (id);


--
-- Name: ReferralLink ReferralLink_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReferralLink"
    ADD CONSTRAINT "ReferralLink_code_key" UNIQUE (code);


--
-- Name: ReferralLink ReferralLink_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReferralLink"
    ADD CONSTRAINT "ReferralLink_pkey" PRIMARY KEY (id);


--
-- Name: Referral Referral_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Referral"
    ADD CONSTRAINT "Referral_pkey" PRIMARY KEY (id);


--
-- Name: RefundRequest RefundRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RefundRequest"
    ADD CONSTRAINT "RefundRequest_pkey" PRIMARY KEY (id);


--
-- Name: Review Review_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Review"
    ADD CONSTRAINT "Review_pkey" PRIMARY KEY (id);


--
-- Name: Routine Routine_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Routine"
    ADD CONSTRAINT "Routine_pkey" PRIMARY KEY (id);


--
-- Name: SignatureRequest SignatureRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SignatureRequest"
    ADD CONSTRAINT "SignatureRequest_pkey" PRIMARY KEY (id);


--
-- Name: SpaceSetting SpaceSetting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SpaceSetting"
    ADD CONSTRAINT "SpaceSetting_pkey" PRIMARY KEY (id);


--
-- Name: SpaceSetting SpaceSetting_spaceId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SpaceSetting"
    ADD CONSTRAINT "SpaceSetting_spaceId_key" UNIQUE ("spaceId");


--
-- Name: SpaceSetting SpaceSetting_unsubscribeToken_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SpaceSetting"
    ADD CONSTRAINT "SpaceSetting_unsubscribeToken_key" UNIQUE ("unsubscribeToken");


--
-- Name: Space Space_ownerId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Space"
    ADD CONSTRAINT "Space_ownerId_key" UNIQUE ("ownerId");


--
-- Name: Space Space_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Space"
    ADD CONSTRAINT "Space_pkey" PRIMARY KEY (id);


--
-- Name: Space Space_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Space"
    ADD CONSTRAINT "Space_slug_key" UNIQUE (slug);


--
-- Name: StripeBridge StripeBridge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StripeBridge"
    ADD CONSTRAINT "StripeBridge_pkey" PRIMARY KEY (id);


--
-- Name: StripeBridge StripeBridge_spaceId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StripeBridge"
    ADD CONSTRAINT "StripeBridge_spaceId_key" UNIQUE ("spaceId");


--
-- Name: StudioBrand StudioBrand_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StudioBrand"
    ADD CONSTRAINT "StudioBrand_pkey" PRIMARY KEY (id);


--
-- Name: StudioBrand StudioBrand_spaceId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StudioBrand"
    ADD CONSTRAINT "StudioBrand_spaceId_key" UNIQUE ("spaceId");


--
-- Name: StudioGeneration StudioGeneration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StudioGeneration"
    ADD CONSTRAINT "StudioGeneration_pkey" PRIMARY KEY (id);


--
-- Name: StudioPost StudioPost_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StudioPost"
    ADD CONSTRAINT "StudioPost_pkey" PRIMARY KEY (id);


--
-- Name: SupportTicket SupportTicket_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SupportTicket"
    ADD CONSTRAINT "SupportTicket_pkey" PRIMARY KEY (id);


--
-- Name: SwarmEvent SwarmEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SwarmEvent"
    ADD CONSTRAINT "SwarmEvent_pkey" PRIMARY KEY (id);


--
-- Name: SwarmMember SwarmMember_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SwarmMember"
    ADD CONSTRAINT "SwarmMember_pkey" PRIMARY KEY (id);


--
-- Name: SwarmRun SwarmRun_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SwarmRun"
    ADD CONSTRAINT "SwarmRun_pkey" PRIMARY KEY (id);


--
-- Name: TaskCheckpoint TaskCheckpoint_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TaskCheckpoint"
    ADD CONSTRAINT "TaskCheckpoint_pkey" PRIMARY KEY (id);


--
-- Name: TaskDependency TaskDependency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TaskDependency"
    ADD CONSTRAINT "TaskDependency_pkey" PRIMARY KEY (id);


--
-- Name: TaskDependency TaskDependency_taskId_dependsOnTaskId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TaskDependency"
    ADD CONSTRAINT "TaskDependency_taskId_dependsOnTaskId_key" UNIQUE ("taskId", "dependsOnTaskId");


--
-- Name: TelemetryEvent TelemetryEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TelemetryEvent"
    ADD CONSTRAINT "TelemetryEvent_pkey" PRIMARY KEY (id);


--
-- Name: User User_clerkId_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_clerkId_key" UNIQUE ("clerkId");


--
-- Name: User User_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);


--
-- Name: AIUserProfile_spaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AIUserProfile_spaceId_idx" ON public."AIUserProfile" USING btree ("spaceId");


--
-- Name: AffiliateAccount_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AffiliateAccount_userId_idx" ON public."AffiliateAccount" USING btree ("userId");


--
-- Name: AgentActivityLog_runId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentActivityLog_runId_idx" ON public."AgentActivityLog" USING btree ("runId");


--
-- Name: AgentActivityLog_spaceId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentActivityLog_spaceId_createdAt_idx" ON public."AgentActivityLog" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: AgentDraft_spaceId_feedback_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentDraft_spaceId_feedback_action_idx" ON public."AgentDraft" USING btree ("spaceId", feedback_action, "createdAt" DESC) WHERE (feedback_action IS NOT NULL);


--
-- Name: AgentDraft_spaceId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentDraft_spaceId_status_idx" ON public."AgentDraft" USING btree ("spaceId", status, "createdAt" DESC);


--
-- Name: AgentGoal_contactId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentGoal_contactId_idx" ON public."AgentGoal" USING btree ("contactId") WHERE ("contactId" IS NOT NULL);


--
-- Name: AgentGoal_dealId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentGoal_dealId_idx" ON public."AgentGoal" USING btree ("dealId") WHERE ("dealId" IS NOT NULL);


--
-- Name: AgentGoal_spaceId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentGoal_spaceId_status_idx" ON public."AgentGoal" USING btree ("spaceId", status);


--
-- Name: AgentMemory_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentMemory_embedding_idx" ON public."AgentMemory" USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: AgentMemory_sourceRunId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentMemory_sourceRunId_idx" ON public."AgentMemory" USING btree ("sourceRunId") WHERE ("sourceRunId" IS NOT NULL);


--
-- Name: AgentMemory_sourceToolName_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentMemory_sourceToolName_idx" ON public."AgentMemory" USING btree ("sourceToolName") WHERE ("sourceToolName" IS NOT NULL);


--
-- Name: AgentMemory_spaceId_entityId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentMemory_spaceId_entityId_idx" ON public."AgentMemory" USING btree ("spaceId", "entityId");


--
-- Name: AgentMemory_spaceId_taskId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentMemory_spaceId_taskId_idx" ON public."AgentMemory" USING btree ("spaceId", "taskId") WHERE ("taskId" IS NOT NULL);


--
-- Name: AgentMemory_taskId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentMemory_taskId_idx" ON public."AgentMemory" USING btree ("taskId") WHERE ("taskId" IS NOT NULL);


--
-- Name: AgentPausedRun_spaceId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentPausedRun_spaceId_status_idx" ON public."AgentPausedRun" USING btree ("spaceId", status, "createdAt" DESC);


--
-- Name: AgentPausedRun_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentPausedRun_userId_idx" ON public."AgentPausedRun" USING btree ("userId");


--
-- Name: AgentQuestion_contactId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentQuestion_contactId_idx" ON public."AgentQuestion" USING btree ("contactId") WHERE ("contactId" IS NOT NULL);


--
-- Name: AgentQuestion_spaceId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentQuestion_spaceId_status_idx" ON public."AgentQuestion" USING btree ("spaceId", status);


--
-- Name: AgentTask_parentTaskId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentTask_parentTaskId_idx" ON public."AgentTask" USING btree ("parentTaskId") WHERE ("parentTaskId" IS NOT NULL);


--
-- Name: AgentTask_spaceId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentTask_spaceId_status_idx" ON public."AgentTask" USING btree ("spaceId", status);


--
-- Name: AgentTrajectory_runId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentTrajectory_runId_idx" ON public."AgentTrajectory" USING btree ("runId");


--
-- Name: AgentTrajectory_spaceId_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentTrajectory_spaceId_provider_idx" ON public."AgentTrajectory" USING btree ("spaceId", provider);


--
-- Name: AgentTrajectory_spaceId_startedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentTrajectory_spaceId_startedAt_idx" ON public."AgentTrajectory" USING btree ("spaceId", "startedAt" DESC);


--
-- Name: AgentTrajectory_toolCalls_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentTrajectory_toolCalls_gin_idx" ON public."AgentTrajectory" USING gin ("toolCalls" jsonb_path_ops);


--
-- Name: AgentTrajectory_trigger_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentTrajectory_trigger_gin_idx" ON public."AgentTrajectory" USING gin (trigger jsonb_path_ops);


--
-- Name: AnnouncementDismissal_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AnnouncementDismissal_user_idx" ON public."AnnouncementDismissal" USING btree ("userId");


--
-- Name: Announcement_active_range_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Announcement_active_range_idx" ON public."Announcement" USING btree (active, "startsAt", "endsAt");


--
-- Name: AppKnowledgeDoc_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AppKnowledgeDoc_category_idx" ON public."AppKnowledgeDoc" USING btree (category);


--
-- Name: AppKnowledgeDoc_searchVector_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AppKnowledgeDoc_searchVector_idx" ON public."AppKnowledgeDoc" USING gin ("searchVector");


--
-- Name: ArtifactVersion_artifactId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ArtifactVersion_artifactId_idx" ON public."ArtifactVersion" USING btree ("artifactId");


--
-- Name: Artifact_spaceId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Artifact_spaceId_status_idx" ON public."Artifact" USING btree ("spaceId", status);


--
-- Name: Artifact_spaceId_taskId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Artifact_spaceId_taskId_idx" ON public."Artifact" USING btree ("spaceId", "taskId");


--
-- Name: Attachment_conversationId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Attachment_conversationId_idx" ON public."Attachment" USING btree ("conversationId") WHERE ("conversationId" IS NOT NULL);


--
-- Name: Attachment_spaceId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Attachment_spaceId_createdAt_idx" ON public."Attachment" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: CalendarEventMirror_external_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CalendarEventMirror_external_idx" ON public."CalendarEventMirror" USING btree ("externalProvider", "externalEventId") WHERE ("externalEventId" IS NOT NULL);


--
-- Name: CalendarEventMirror_space_start_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CalendarEventMirror_space_start_idx" ON public."CalendarEventMirror" USING btree ("spaceId", start);


--
-- Name: CallLog_contactId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CallLog_contactId_createdAt_idx" ON public."CallLog" USING btree ("contactId", "createdAt" DESC);


--
-- Name: CallLog_spaceId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CallLog_spaceId_createdAt_idx" ON public."CallLog" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: CallLog_telnyxCallId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CallLog_telnyxCallId_idx" ON public."CallLog" USING btree ("telnyxCallId");


--
-- Name: ChatUsage_spaceId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChatUsage_spaceId_createdAt_idx" ON public."ChatUsage" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: ChatUsage_spaceId_model_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChatUsage_spaceId_model_idx" ON public."ChatUsage" USING btree ("spaceId", model);


--
-- Name: ChatUsage_spaceId_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChatUsage_spaceId_provider_idx" ON public."ChatUsage" USING btree ("spaceId", provider);


--
-- Name: ChatUsage_spaceId_route_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChatUsage_spaceId_route_idx" ON public."ChatUsage" USING btree ("spaceId", route);


--
-- Name: ClientAuthCode_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ClientAuthCode_lookup_idx" ON public."ClientAuthCode" USING btree ("emailLower", purpose, "expiresAt");


--
-- Name: ClientDocument_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ClientDocument_contact_idx" ON public."ClientDocument" USING btree ("contactId", "createdAt");


--
-- Name: ClientInfoRequest_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ClientInfoRequest_contact_idx" ON public."ClientInfoRequest" USING btree ("contactId", status);


--
-- Name: ClientMessage_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ClientMessage_contact_idx" ON public."ClientMessage" USING btree ("contactId", "createdAt");


--
-- Name: ClientUser_emailLower_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ClientUser_emailLower_key" ON public."ClientUser" USING btree ("emailLower");


--
-- Name: CmaReport_shareToken_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "CmaReport_shareToken_key" ON public."CmaReport" USING btree ("shareToken");


--
-- Name: CmaReport_space_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CmaReport_space_created_idx" ON public."CmaReport" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: CompanyIntegrationConnection_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "CompanyIntegrationConnection_active_unique" ON public."CompanyIntegrationConnection" USING btree ("companyId", "userId", toolkit) WHERE (status = 'active'::text);


--
-- Name: CompanyIntegrationConnection_companyId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CompanyIntegrationConnection_companyId_idx" ON public."CompanyIntegrationConnection" USING btree ("companyId", status);


--
-- Name: CompanyIntegrationConnection_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CompanyIntegrationConnection_userId_idx" ON public."CompanyIntegrationConnection" USING btree ("userId");


--
-- Name: CustomAgent_spaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CustomAgent_spaceId_idx" ON public."CustomAgent" USING btree ("spaceId");


--
-- Name: DeadLetterEvent_eventType_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DeadLetterEvent_eventType_idx" ON public."DeadLetterEvent" USING btree ("eventType");


--
-- Name: DeadLetterEvent_spaceId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DeadLetterEvent_spaceId_status_idx" ON public."DeadLetterEvent" USING btree ("spaceId", status);


--
-- Name: DealStage_pipelineId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DealStage_pipelineId_idx" ON public."DealStage" USING btree ("pipelineId");


--
-- Name: DisabledSpace_spaceId_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "DisabledSpace_spaceId_active_idx" ON public."DisabledSpace" USING btree ("spaceId") WHERE ("isActive" = true);


--
-- Name: DisabledSpace_spaceId_isActive_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DisabledSpace_spaceId_isActive_idx" ON public."DisabledSpace" USING btree ("spaceId", "isActive");


--
-- Name: DocumentEmbedding_tsv_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DocumentEmbedding_tsv_gin_idx" ON public."DocumentEmbedding" USING gin (tsv);


--
-- Name: EmailBroadcast_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "EmailBroadcast_createdAt_idx" ON public."EmailBroadcast" USING btree ("createdAt" DESC);


--
-- Name: ExecutionStep_idempotencyKey_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ExecutionStep_idempotencyKey_idx" ON public."ExecutionStep" USING btree ("idempotencyKey") WHERE ("idempotencyKey" IS NOT NULL);


--
-- Name: ExecutionStep_taskId_stepIndex_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ExecutionStep_taskId_stepIndex_idx" ON public."ExecutionStep" USING btree ("taskId", "stepIndex");


--
-- Name: File_spaceId_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "File_spaceId_category_idx" ON public."File" USING btree ("spaceId", category, "createdAt" DESC);


--
-- Name: File_spaceId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "File_spaceId_createdAt_idx" ON public."File" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: File_userId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "File_userId_createdAt_idx" ON public."File" USING btree ("userId", "createdAt" DESC);


--
-- Name: GoalDecomposition_spaceId_taskId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GoalDecomposition_spaceId_taskId_idx" ON public."GoalDecomposition" USING btree ("spaceId", "taskId");


--
-- Name: IntegrationConnection_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IntegrationConnection_active_unique" ON public."IntegrationConnection" USING btree ("spaceId", "userId", toolkit) WHERE (status = 'active'::text);


--
-- Name: IntegrationConnection_spaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IntegrationConnection_spaceId_idx" ON public."IntegrationConnection" USING btree ("spaceId", status);


--
-- Name: IntegrationConnection_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IntegrationConnection_userId_idx" ON public."IntegrationConnection" USING btree ("userId");


--
-- Name: IntegrationTrigger_composioTriggerId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IntegrationTrigger_composioTriggerId_idx" ON public."IntegrationTrigger" USING btree ("composioTriggerId") WHERE ("composioTriggerId" IS NOT NULL);


--
-- Name: IntegrationTrigger_connectionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IntegrationTrigger_connectionId_idx" ON public."IntegrationTrigger" USING btree ("connectionId");


--
-- Name: IntegrationTrigger_connection_slug_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IntegrationTrigger_connection_slug_unique" ON public."IntegrationTrigger" USING btree ("connectionId", "triggerSlug");


--
-- Name: ManagerConversation_companyId_updatedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ManagerConversation_companyId_updatedAt_idx" ON public."ManagerConversation" USING btree ("companyId", "updatedAt" DESC);


--
-- Name: ManagerMessage_conversationId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ManagerMessage_conversationId_createdAt_idx" ON public."ManagerMessage" USING btree ("conversationId", "createdAt");


--
-- Name: Pipeline_spaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Pipeline_spaceId_idx" ON public."Pipeline" USING btree ("spaceId");


--
-- Name: PushSubscription_spaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PushSubscription_spaceId_idx" ON public."PushSubscription" USING btree ("spaceId");


--
-- Name: Routine_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Routine_due_idx" ON public."Routine" USING btree ("nextRunAt") WHERE (enabled = true);


--
-- Name: Routine_space_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Routine_space_idx" ON public."Routine" USING btree ("spaceId");


--
-- Name: SignatureRequest_contactId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SignatureRequest_contactId_createdAt_idx" ON public."SignatureRequest" USING btree ("contactId", "createdAt" DESC);


--
-- Name: SignatureRequest_dealId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SignatureRequest_dealId_idx" ON public."SignatureRequest" USING btree ("dealId");


--
-- Name: SignatureRequest_envelopeId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SignatureRequest_envelopeId_idx" ON public."SignatureRequest" USING btree ("envelopeId");


--
-- Name: SignatureRequest_spaceId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SignatureRequest_spaceId_createdAt_idx" ON public."SignatureRequest" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: StudioGeneration_falRequestId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "StudioGeneration_falRequestId_idx" ON public."StudioGeneration" USING btree ("falRequestId") WHERE ("falRequestId" IS NOT NULL);


--
-- Name: StudioGeneration_spaceId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "StudioGeneration_spaceId_createdAt_idx" ON public."StudioGeneration" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: StudioPost_spaceId_scheduledAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "StudioPost_spaceId_scheduledAt_idx" ON public."StudioPost" USING btree ("spaceId", "scheduledAt");


--
-- Name: SupportTicket_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_createdAt_idx" ON public."SupportTicket" USING btree ("createdAt" DESC);


--
-- Name: SupportTicket_spaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_spaceId_idx" ON public."SupportTicket" USING btree ("spaceId");


--
-- Name: SupportTicket_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_status_idx" ON public."SupportTicket" USING btree (status);


--
-- Name: SupportTicket_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SupportTicket_userId_idx" ON public."SupportTicket" USING btree ("userId", "createdAt" DESC);


--
-- Name: SwarmEvent_swarmRunId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SwarmEvent_swarmRunId_createdAt_idx" ON public."SwarmEvent" USING btree ("swarmRunId", "createdAt");


--
-- Name: SwarmMember_swarmRunId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SwarmMember_swarmRunId_idx" ON public."SwarmMember" USING btree ("swarmRunId");


--
-- Name: SwarmRun_spaceId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SwarmRun_spaceId_createdAt_idx" ON public."SwarmRun" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: TaskCheckpoint_taskId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "TaskCheckpoint_taskId_idx" ON public."TaskCheckpoint" USING btree ("taskId");


--
-- Name: TaskDependency_dependsOnTaskId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "TaskDependency_dependsOnTaskId_idx" ON public."TaskDependency" USING btree ("dependsOnTaskId");


--
-- Name: TaskDependency_taskId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "TaskDependency_taskId_idx" ON public."TaskDependency" USING btree ("taskId");


--
-- Name: TelemetryEvent_event_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "TelemetryEvent_event_createdAt_idx" ON public."TelemetryEvent" USING btree (event, "createdAt" DESC);


--
-- Name: TelemetryEvent_spaceId_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "TelemetryEvent_spaceId_event_idx" ON public."TelemetryEvent" USING btree ("spaceId", event);


--
-- Name: audit_actor_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_actor_created_idx ON public."AuditLog" USING btree ("clerkId", "createdAt" DESC);


--
-- Name: audit_log_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_actor_idx ON public."AuditLog" USING btree ("actorId");


--
-- Name: audit_log_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_created_idx ON public."AuditLog" USING btree ("createdAt" DESC);


--
-- Name: audit_log_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_resource_idx ON public."AuditLog" USING btree (resource, "resourceId");


--
-- Name: audit_log_space_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_space_idx ON public."AuditLog" USING btree ("spaceId");


--
-- Name: audit_resource_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_resource_created_idx ON public."AuditLog" USING btree (resource, "resourceId", "createdAt" DESC);


--
-- Name: contact_follow_up_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_follow_up_idx ON public."Contact" USING btree ("spaceId", "followUpAt" DESC);


--
-- Name: contact_scoring_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_scoring_status_idx ON public."Contact" USING btree ("spaceId", "scoringStatus");


--
-- Name: contact_space_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_space_created_idx ON public."Contact" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: deal_contact_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deal_contact_contact_idx ON public."DealContact" USING btree ("contactId");


--
-- Name: deal_follow_up_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deal_follow_up_idx ON public."Deal" USING btree ("spaceId", "followUpAt" DESC);


--
-- Name: deal_space_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deal_space_position_idx ON public."Deal" USING btree ("spaceId", "position");


--
-- Name: deal_stage_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deal_stage_position_idx ON public."Deal" USING btree ("stageId", "position");


--
-- Name: deal_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deal_status_idx ON public."Deal" USING btree ("spaceId", status);


--
-- Name: embedding_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX embedding_entity_idx ON public."DocumentEmbedding" USING btree ("entityType", "entityId");


--
-- Name: idx_affiliate_commission_partner_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_commission_partner_status ON public."AffiliateCommission" USING btree ("partnerId", status);


--
-- Name: idx_affiliate_commission_payable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_commission_payable ON public."AffiliateCommission" USING btree ("partnerId", status, "matureAt");


--
-- Name: idx_affiliate_commission_referral; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_commission_referral ON public."AffiliateCommission" USING btree ("referralId") WHERE ("referralId" IS NOT NULL);


--
-- Name: idx_affiliate_commission_space_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_commission_space_status ON public."AffiliateCommission" USING btree ("spaceId", status, "createdAt" DESC);


--
-- Name: idx_affiliate_commission_stripe_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_affiliate_commission_stripe_invoice ON public."AffiliateCommission" USING btree ("stripeInvoiceId") WHERE ("stripeInvoiceId" IS NOT NULL);


--
-- Name: idx_affiliate_commission_unsettled_bridge; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_commission_unsettled_bridge ON public."AffiliateCommission" USING btree ("spaceId") WHERE ((source = 'stripe_bridge'::text) AND ("settledAt" IS NULL));


--
-- Name: idx_affiliate_partner_clerk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_partner_clerk ON public."AffiliatePartner" USING btree ("clerkUserId") WHERE ("clerkUserId" IS NOT NULL);


--
-- Name: idx_affiliate_partner_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_partner_email ON public."AffiliatePartner" USING btree (lower(email));


--
-- Name: idx_affiliate_partner_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_partner_parent ON public."AffiliatePartner" USING btree ("parentPartnerId") WHERE ("parentPartnerId" IS NOT NULL);


--
-- Name: idx_affiliate_partner_space_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_affiliate_partner_space_email ON public."AffiliatePartner" USING btree ("spaceId", lower(email));


--
-- Name: idx_affiliate_payout_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_payout_partner ON public."AffiliatePayout" USING btree ("partnerId", "createdAt" DESC);


--
-- Name: idx_affiliate_payout_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_payout_space ON public."AffiliatePayout" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: idx_affiliate_program_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_program_space ON public."AffiliateProgram" USING btree ("spaceId");


--
-- Name: idx_app_message_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_message_contact ON public."ApplicationMessage" USING btree ("contactId", "createdAt");


--
-- Name: idx_app_message_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_message_space ON public."ApplicationMessage" USING btree ("spaceId");


--
-- Name: idx_app_message_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_message_unread ON public."ApplicationMessage" USING btree ("contactId", "readAt") WHERE ("readAt" IS NULL);


--
-- Name: idx_app_status_update_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_status_update_contact ON public."ApplicationStatusUpdate" USING btree ("contactId", "createdAt");


--
-- Name: idx_app_status_update_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_status_update_space ON public."ApplicationStatusUpdate" USING btree ("spaceId");


--
-- Name: idx_audit_clerk_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_clerk_id ON public."AuditLog" USING btree ("clerkId");


--
-- Name: idx_audit_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_created_at ON public."AuditLog" USING btree ("createdAt");


--
-- Name: idx_audit_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_resource ON public."AuditLog" USING btree (resource, "resourceId");


--
-- Name: idx_audit_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_space_id ON public."AuditLog" USING btree ("spaceId");


--
-- Name: idx_brief_space_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_brief_space_date ON public."Brief" USING btree ("spaceId", "forDate");


--
-- Name: idx_brief_space_date_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brief_space_date_created ON public."Brief" USING btree ("spaceId", "forDate" DESC, "createdAt" DESC);


--
-- Name: idx_brieftip_space_cat_subject_fired; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brieftip_space_cat_subject_fired ON public."BriefTipHistory" USING btree ("spaceId", "tipCategory", "subjectId", "firedAt" DESC);


--
-- Name: idx_calendar_event_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_event_space ON public."CalendarEvent" USING btree ("spaceId", date);


--
-- Name: idx_calendar_note_space_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_note_space_date ON public."CalendarNote" USING btree ("spaceId", date);


--
-- Name: idx_commission_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commission_agent ON public."CommissionLedger" USING btree ("agentUserId", "closedAt" DESC);


--
-- Name: idx_commission_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commission_company ON public."CommissionLedger" USING btree ("companyId", "closedAt" DESC);


--
-- Name: idx_commission_split_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commission_split_deal ON public."CommissionSplit" USING btree ("dealId");


--
-- Name: idx_commission_split_space_paid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commission_split_space_paid ON public."CommissionSplit" USING btree ("spaceId", "paidAt");


--
-- Name: idx_commission_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commission_status ON public."CommissionLedger" USING btree (status);


--
-- Name: idx_company_buyer_form_config; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_buyer_form_config ON public."Company" USING gin ("companyBuyerFormConfig") WHERE ("companyBuyerFormConfig" IS NOT NULL);


--
-- Name: idx_company_form_config; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_form_config ON public."Company" USING gin ("companyFormConfig") WHERE ("companyFormConfig" IS NOT NULL);


--
-- Name: idx_company_join_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_company_join_code ON public."Company" USING btree ("joinCode");


--
-- Name: idx_company_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_company_owner ON public."Company" USING btree ("ownerId");


--
-- Name: idx_company_removal_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_removal_user ON public."CompanyRemoval" USING btree ("userId");


--
-- Name: idx_company_rental_form_config; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_rental_form_config ON public."Company" USING gin ("companyRentalFormConfig") WHERE ("companyRentalFormConfig" IS NOT NULL);


--
-- Name: idx_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_status ON public."Company" USING btree (status);


--
-- Name: idx_company_stripe_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_stripe_customer ON public."Company" USING btree ("stripeCustomerId") WHERE ("stripeCustomerId" IS NOT NULL);


--
-- Name: idx_company_stripe_sub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_stripe_sub ON public."Company" USING btree ("stripeSubscriptionId") WHERE ("stripeSubscriptionId" IS NOT NULL);


--
-- Name: idx_company_template_company_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_template_company_updated ON public."CompanyTemplate" USING btree ("companyId", "updatedAt" DESC);


--
-- Name: idx_contact_app_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_app_ref ON public."Contact" USING btree ("applicationRef");


--
-- Name: idx_contact_application_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_application_ref ON public."Contact" USING btree ("applicationRef") WHERE ("applicationRef" IS NOT NULL);


--
-- Name: idx_contact_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_company ON public."Contact" USING btree ("companyId");


--
-- Name: idx_contact_document_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_document_contact ON public."ContactDocument" USING btree ("contactId");


--
-- Name: idx_contact_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_email ON public."Contact" USING btree (email);


--
-- Name: idx_contact_form_lead_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_form_lead_type ON public."Contact" USING btree ("formLeadType") WHERE ("formLeadType" IS NOT NULL);


--
-- Name: idx_contact_lead_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_lead_type ON public."Contact" USING btree ("spaceId", "leadType");


--
-- Name: idx_contact_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_phone ON public."Contact" USING btree (phone);


--
-- Name: idx_contact_snoozed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_snoozed ON public."Contact" USING btree ("spaceId", "snoozedUntil") WHERE ("snoozedUntil" IS NOT NULL);


--
-- Name: idx_contact_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_space_id ON public."Contact" USING btree ("spaceId");


--
-- Name: idx_contact_status_portal_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_status_portal_token ON public."Contact" USING btree ("statusPortalToken") WHERE ("statusPortalToken" IS NOT NULL);


--
-- Name: idx_contact_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_tags ON public."Contact" USING gin (tags);


--
-- Name: idx_conversation_space_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_space_updated ON public."Conversation" USING btree ("spaceId", "updatedAt" DESC);


--
-- Name: idx_creator_profile_clerk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_creator_profile_clerk ON public."CreatorProfile" USING btree ("clerkUserId") WHERE ("clerkUserId" IS NOT NULL);


--
-- Name: idx_creator_profile_listed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_creator_profile_listed ON public."CreatorProfile" USING btree ("audienceSize" DESC) WHERE (listed = true);


--
-- Name: idx_creditlot_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_creditlot_account ON public."CreditLot" USING btree ("accountType", "accountId") WHERE (remaining > 0);


--
-- Name: idx_creditlot_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_creditlot_expiry ON public."CreditLot" USING btree ("expiresAt");


--
-- Name: idx_credittxn_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credittxn_account ON public."CreditTxn" USING btree ("accountType", "accountId", "createdAt" DESC);


--
-- Name: idx_deal_activity_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_activity_deal ON public."DealActivity" USING btree ("dealId");


--
-- Name: idx_deal_activity_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_activity_space ON public."DealActivity" USING btree ("spaceId");


--
-- Name: idx_deal_activity_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_activity_type ON public."DealActivity" USING btree (type);


--
-- Name: idx_deal_checklist_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_checklist_deal ON public."DealChecklistItem" USING btree ("dealId", "position");


--
-- Name: idx_deal_checklist_due_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_checklist_due_open ON public."DealChecklistItem" USING btree ("spaceId", "dueAt") WHERE ("completedAt" IS NULL);


--
-- Name: idx_deal_checklist_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_checklist_space ON public."DealChecklistItem" USING btree ("spaceId");


--
-- Name: idx_deal_contact_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_contact_role ON public."DealContact" USING btree ("dealId", role) WHERE (role IS NOT NULL);


--
-- Name: idx_deal_document_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_document_deal ON public."DealDocument" USING btree ("dealId", "createdAt" DESC);


--
-- Name: idx_deal_document_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_document_space ON public."DealDocument" USING btree ("spaceId");


--
-- Name: idx_deal_next_action_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_next_action_due ON public."Deal" USING btree ("spaceId", "nextActionDueAt") WHERE ("nextAction" IS NOT NULL);


--
-- Name: idx_deal_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_product ON public."Deal" USING btree ("productId") WHERE ("productId" IS NOT NULL);


--
-- Name: idx_deal_routing_rule_company_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_routing_rule_company_enabled ON public."DealRoutingRule" USING btree ("companyId", enabled);


--
-- Name: idx_deal_routing_rule_company_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_routing_rule_company_priority ON public."DealRoutingRule" USING btree ("companyId", priority, enabled);


--
-- Name: idx_deal_source_demo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_source_demo ON public."Deal" USING btree ("sourceDemoId");


--
-- Name: idx_deal_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_space_id ON public."Deal" USING btree ("spaceId");


--
-- Name: idx_deal_stage_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_stage_id ON public."Deal" USING btree ("stageId");


--
-- Name: idx_deal_stage_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_stage_kind ON public."DealStage" USING btree ("spaceId", kind) WHERE (kind IS NOT NULL);


--
-- Name: idx_deal_stage_pipeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_stage_pipeline ON public."DealStage" USING btree ("spaceId", "pipelineType");


--
-- Name: idx_dealcontact_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dealcontact_contact ON public."DealContact" USING btree ("contactId");


--
-- Name: idx_dealcontact_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dealcontact_deal ON public."DealContact" USING btree ("dealId");


--
-- Name: idx_dealreview_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dealreview_company_status ON public."DealReviewRequest" USING btree ("companyId", status);


--
-- Name: idx_dealreview_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dealreview_deal ON public."DealReviewRequest" USING btree ("dealId");


--
-- Name: idx_dealreview_open_per_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_dealreview_open_per_deal ON public."DealReviewRequest" USING btree ("dealId") WHERE (status = 'open'::text);


--
-- Name: idx_dealreviewcomment_request_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dealreviewcomment_request_created ON public."DealReviewComment" USING btree ("reviewRequestId", "createdAt");


--
-- Name: idx_dealstage_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dealstage_space_id ON public."DealStage" USING btree ("spaceId");


--
-- Name: idx_demo_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_contact ON public."Demo" USING btree ("contactId");


--
-- Name: idx_demo_feedback_demo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_feedback_demo ON public."DemoFeedback" USING btree ("demoId");


--
-- Name: idx_demo_feedback_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_feedback_space ON public."DemoFeedback" USING btree ("spaceId");


--
-- Name: idx_demo_manage_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_manage_token ON public."Demo" USING btree ("manageToken");


--
-- Name: idx_demo_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_product ON public."Demo" USING btree ("productId") WHERE ("productId" IS NOT NULL);


--
-- Name: idx_demo_product_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_product_profile ON public."Demo" USING btree ("productProfileId");


--
-- Name: idx_demo_space_starts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_space_starts ON public."Demo" USING btree ("spaceId", "startsAt" DESC);


--
-- Name: idx_demo_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_status ON public."Demo" USING btree (status);


--
-- Name: idx_doc_embedding_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_embedding_entity ON public."DocumentEmbedding" USING btree ("entityId");


--
-- Name: idx_doc_embedding_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_embedding_hnsw ON public."DocumentEmbedding" USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_doc_embedding_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_embedding_space ON public."DocumentEmbedding" USING btree ("spaceId");


--
-- Name: idx_email_suppression_email_list; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_email_suppression_email_list ON public."EmailSuppression" USING btree (email, "listType");


--
-- Name: idx_form_analytics_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_form_analytics_created ON public."FormAnalyticsEvent" USING btree ("createdAt");


--
-- Name: idx_form_analytics_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_form_analytics_event_type ON public."FormAnalyticsEvent" USING btree ("eventType");


--
-- Name: idx_form_analytics_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_form_analytics_session ON public."FormAnalyticsEvent" USING btree ("sessionId");


--
-- Name: idx_form_analytics_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_form_analytics_space ON public."FormAnalyticsEvent" USING btree ("spaceId");


--
-- Name: idx_form_analytics_space_created_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_form_analytics_space_created_type ON public."FormAnalyticsEvent" USING btree ("spaceId", "createdAt" DESC, "eventType");


--
-- Name: idx_form_draft_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_form_draft_expires_at ON public."FormDraft" USING btree ("expiresAt");


--
-- Name: idx_form_draft_resume_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_form_draft_resume_token ON public."FormDraft" USING btree ("resumeToken");


--
-- Name: idx_form_draft_space_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_form_draft_space_email ON public."FormDraft" USING btree ("spaceId", email);


--
-- Name: idx_invitation_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitation_company ON public."Invitation" USING btree ("companyId");


--
-- Name: idx_invitation_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitation_email ON public."Invitation" USING btree (email);


--
-- Name: idx_invitation_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitation_status ON public."Invitation" USING btree (status);


--
-- Name: idx_invitation_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitation_token ON public."Invitation" USING btree (token);


--
-- Name: idx_license_buyer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_license_buyer ON public."License" USING btree (lower("buyerEmail"));


--
-- Name: idx_license_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_license_order ON public."License" USING btree ("orderId");


--
-- Name: idx_manager_notif_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manager_notif_company ON public."ManagerNotification" USING btree ("companyId", "createdAt" DESC);


--
-- Name: idx_manager_notif_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_manager_notif_unread ON public."ManagerNotification" USING btree ("companyId", read) WHERE (read = false);


--
-- Name: idx_marketplace_order_buyer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_order_buyer ON public."MarketplaceOrder" USING btree (lower("buyerEmail"));


--
-- Name: idx_marketplace_order_payment_intent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_order_payment_intent ON public."MarketplaceOrder" USING btree ("stripePaymentIntentId") WHERE ("stripePaymentIntentId" IS NOT NULL);


--
-- Name: idx_marketplace_order_space_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_order_space_created ON public."MarketplaceOrder" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: idx_marketplace_order_stripe_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_order_stripe_customer ON public."MarketplaceOrder" USING btree ("stripeCustomerId") WHERE ("stripeCustomerId" IS NOT NULL);


--
-- Name: idx_marketplace_order_stripe_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_order_stripe_session ON public."MarketplaceOrder" USING btree ("stripeCheckoutSessionId") WHERE ("stripeCheckoutSessionId" IS NOT NULL);


--
-- Name: idx_marketplace_order_stripe_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_order_stripe_subscription ON public."MarketplaceOrder" USING btree ("stripeSubscriptionId") WHERE ("stripeSubscriptionId" IS NOT NULL);


--
-- Name: idx_mcp_api_key_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_api_key_client_id ON public."McpApiKey" USING btree ("clientId");


--
-- Name: idx_mcp_api_key_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_api_key_expires ON public."McpApiKey" USING btree ("expiresAt") WHERE ("expiresAt" IS NOT NULL);


--
-- Name: idx_mcp_api_key_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_api_key_hash ON public."McpApiKey" USING btree ("keyHash");


--
-- Name: idx_mcp_api_key_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_api_key_space ON public."McpApiKey" USING btree ("spaceId");


--
-- Name: idx_mcp_auth_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_auth_code ON public."McpAuthCode" USING btree (code);


--
-- Name: idx_membership_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membership_company ON public."CompanyMembership" USING btree ("companyId");


--
-- Name: idx_membership_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membership_user ON public."CompanyMembership" USING btree ("userId");


--
-- Name: idx_message_conversation_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_conversation_created ON public."Message" USING btree ("conversationId", "createdAt");


--
-- Name: idx_message_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_space_id ON public."Message" USING btree ("spaceId");


--
-- Name: idx_message_template_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_template_source ON public."MessageTemplate" USING btree ("sourceTemplateId") WHERE ("sourceTemplateId" IS NOT NULL);


--
-- Name: idx_message_template_space_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_template_space_updated ON public."MessageTemplate" USING btree ("spaceId", "updatedAt" DESC);


--
-- Name: idx_note_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_note_space ON public."Note" USING btree ("spaceId", "sortOrder");


--
-- Name: idx_override_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_override_space ON public."DemoAvailabilityOverride" USING btree ("spaceId");


--
-- Name: idx_override_space_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_override_space_date ON public."DemoAvailabilityOverride" USING btree ("spaceId", date);


--
-- Name: idx_product_assigned_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_assigned_space ON public."Product" USING btree ("assignedSpaceId") WHERE ("assignedSpaceId" IS NOT NULL);


--
-- Name: idx_product_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_company ON public."Product" USING btree ("companyId", "updatedAt" DESC) WHERE ("companyId" IS NOT NULL);


--
-- Name: idx_product_featured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_featured ON public."Product" USING btree (featured, "updatedAt" DESC) WHERE ((published = true) AND (featured = true));


--
-- Name: idx_product_marketplace_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_product_marketplace_slug ON public."Product" USING btree ("marketplaceSlug") WHERE ("marketplaceSlug" IS NOT NULL);


--
-- Name: idx_product_packet_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_packet_product ON public."ProductPacket" USING btree ("productId");


--
-- Name: idx_product_packet_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_packet_space ON public."ProductPacket" USING btree ("spaceId", "createdAt" DESC);


--
-- Name: idx_product_profile_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_profile_space ON public."DemoProductProfile" USING btree ("spaceId");


--
-- Name: idx_product_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_published ON public."Product" USING btree (published, category) WHERE (published = true);


--
-- Name: idx_product_space_address; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_space_address ON public."Product" USING btree ("spaceId", lower(address));


--
-- Name: idx_product_space_mls; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_product_space_mls ON public."Product" USING btree ("spaceId", "mlsNumber") WHERE ("mlsNumber" IS NOT NULL);


--
-- Name: idx_product_space_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_space_updated ON public."Product" USING btree ("spaceId", "updatedAt" DESC);


--
-- Name: idx_product_verified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_verified ON public."Product" USING btree (verified) WHERE ((published = true) AND (verified = true));


--
-- Name: idx_productview_product_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_productview_product_created ON public."ProductView" USING btree ("productId", "createdAt" DESC);


--
-- Name: idx_referral_click_link_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referral_click_link_created ON public."ReferralClick" USING btree ("linkId", "createdAt" DESC);


--
-- Name: idx_referral_link_buyer; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_referral_link_buyer ON public."Referral" USING btree ("linkId", lower("buyerEmail"));


--
-- Name: idx_referral_link_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referral_link_partner ON public."ReferralLink" USING btree ("partnerId");


--
-- Name: idx_referral_link_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referral_link_product ON public."ReferralLink" USING btree ("productId") WHERE ("productId" IS NOT NULL);


--
-- Name: idx_referral_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referral_partner ON public."Referral" USING btree ("partnerId");


--
-- Name: idx_refund_request_open_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_refund_request_open_order ON public."RefundRequest" USING btree ("orderId") WHERE (status = 'requested'::text);


--
-- Name: idx_refund_request_space_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refund_request_space_status ON public."RefundRequest" USING btree ("spaceId", status, "createdAt" DESC);


--
-- Name: idx_review_product_buyer; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_review_product_buyer ON public."Review" USING btree ("productId", lower("buyerEmail"));


--
-- Name: idx_review_product_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_product_status ON public."Review" USING btree ("productId", status, "createdAt" DESC);


--
-- Name: idx_space_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_space_company ON public."Space" USING btree ("companyId");


--
-- Name: idx_space_owner_clerk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_space_owner_clerk ON public."Space" USING btree ("ownerId");


--
-- Name: idx_space_owner_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_space_owner_id ON public."Space" USING btree ("ownerId");


--
-- Name: idx_space_setting_buyer_form_config; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_space_setting_buyer_form_config ON public."SpaceSetting" USING gin ("buyerFormConfig") WHERE ("buyerFormConfig" IS NOT NULL);


--
-- Name: idx_space_setting_form_config; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_space_setting_form_config ON public."SpaceSetting" USING gin ("formConfig") WHERE ("formConfig" IS NOT NULL);


--
-- Name: idx_space_setting_form_config_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_space_setting_form_config_source ON public."SpaceSetting" USING btree ("formConfigSource");


--
-- Name: idx_space_setting_rental_form_config; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_space_setting_rental_form_config ON public."SpaceSetting" USING gin ("rentalFormConfig") WHERE ("rentalFormConfig" IS NOT NULL);


--
-- Name: idx_space_setting_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_space_setting_sid ON public."SpaceSetting" USING btree ("spaceId");


--
-- Name: idx_space_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_space_slug ON public."Space" USING btree (slug);


--
-- Name: idx_space_stripe_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_space_stripe_customer ON public."Space" USING btree ("stripeCustomerId");


--
-- Name: idx_user_clerk_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_clerk_id ON public."User" USING btree ("clerkId");


--
-- Name: idx_waitlist_space_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_waitlist_space_date ON public."DemoWaitlist" USING btree ("spaceId", "preferredDate");


--
-- Name: idx_waitlist_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_waitlist_status ON public."DemoWaitlist" USING btree (status);


--
-- Name: message_space_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_space_created_idx ON public."Message" USING btree ("spaceId", "createdAt");


--
-- Name: uq_company_stripe_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_company_stripe_subscription ON public."Company" USING btree ("stripeSubscriptionId") WHERE ("stripeSubscriptionId" IS NOT NULL);


--
-- Name: uq_creditlot_free_signup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_creditlot_free_signup ON public."CreditLot" USING btree ("accountType", "accountId") WHERE (reason = 'free_signup'::text);


--
-- Name: uq_creditlot_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_creditlot_source ON public."CreditLot" USING btree (reason, "sourceId") WHERE ("sourceId" IS NOT NULL);


--
-- Name: uq_invitation_pending_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_invitation_pending_email ON public."Invitation" USING btree ("companyId", lower(email)) WHERE (status = 'pending'::text);


--
-- Name: uq_space_stripe_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_space_stripe_subscription ON public."Space" USING btree ("stripeSubscriptionId") WHERE ("stripeSubscriptionId" IS NOT NULL);


--
-- Name: AgentGoal AgentGoal_updatedAt; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "AgentGoal_updatedAt" BEFORE UPDATE ON public."AgentGoal" FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: Routine Routine_next_run; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "Routine_next_run" BEFORE INSERT OR UPDATE ON public."Routine" FOR EACH ROW EXECUTE FUNCTION public.routine_set_next_run();


--
-- Name: Space space_autoseed_agent_settings; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER space_autoseed_agent_settings AFTER INSERT ON public."Space" FOR EACH ROW EXECUTE FUNCTION public.ensure_agent_settings_for_space();


--
-- Name: ChatUsage trg_charge_credits_on_chat_usage; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_charge_credits_on_chat_usage AFTER INSERT ON public."ChatUsage" FOR EACH ROW EXECUTE FUNCTION public.charge_credits_for_chat_usage();


--
-- Name: Deal trg_deal_won_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_deal_won_insert AFTER INSERT ON public."Deal" FOR EACH ROW WHEN ((new.status = 'won'::text)) EXECUTE FUNCTION public.sync_commission_ledger();


--
-- Name: Deal trg_deal_won_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_deal_won_update AFTER UPDATE OF status ON public."Deal" FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) AND (new.status = 'won'::text))) EXECUTE FUNCTION public.sync_commission_ledger();


--
-- Name: Company trg_purge_credits_on_company_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_purge_credits_on_company_delete AFTER DELETE ON public."Company" FOR EACH ROW EXECUTE FUNCTION public.purge_credit_rows_for_account('company');


--
-- Name: Space trg_purge_credits_on_space_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_purge_credits_on_space_delete AFTER DELETE ON public."Space" FOR EACH ROW EXECUTE FUNCTION public.purge_credit_rows_for_account('space');


--
-- Name: SpaceSetting trg_stamp_brief_enabled_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_stamp_brief_enabled_at BEFORE INSERT OR UPDATE OF "briefEnabled" ON public."SpaceSetting" FOR EACH ROW EXECUTE FUNCTION public.stamp_brief_enabled_at();


--
-- Name: AIUserProfile AIUserProfile_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AIUserProfile"
    ADD CONSTRAINT "AIUserProfile_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AffiliateAccount AffiliateAccount_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliateAccount"
    ADD CONSTRAINT "AffiliateAccount_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AffiliateCommission AffiliateCommission_partnerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliateCommission"
    ADD CONSTRAINT "AffiliateCommission_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES public."AffiliatePartner"(id) ON DELETE CASCADE;


--
-- Name: AffiliateCommission AffiliateCommission_referralId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliateCommission"
    ADD CONSTRAINT "AffiliateCommission_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES public."Referral"(id) ON DELETE SET NULL;


--
-- Name: AffiliateCommission AffiliateCommission_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliateCommission"
    ADD CONSTRAINT "AffiliateCommission_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AffiliatePartner AffiliatePartner_parentPartnerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliatePartner"
    ADD CONSTRAINT "AffiliatePartner_parentPartnerId_fkey" FOREIGN KEY ("parentPartnerId") REFERENCES public."AffiliatePartner"(id) ON DELETE SET NULL;


--
-- Name: AffiliatePartner AffiliatePartner_programId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliatePartner"
    ADD CONSTRAINT "AffiliatePartner_programId_fkey" FOREIGN KEY ("programId") REFERENCES public."AffiliateProgram"(id) ON DELETE CASCADE;


--
-- Name: AffiliatePartner AffiliatePartner_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliatePartner"
    ADD CONSTRAINT "AffiliatePartner_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AffiliatePayout AffiliatePayout_partnerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliatePayout"
    ADD CONSTRAINT "AffiliatePayout_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES public."AffiliatePartner"(id) ON DELETE CASCADE;


--
-- Name: AffiliatePayout AffiliatePayout_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliatePayout"
    ADD CONSTRAINT "AffiliatePayout_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AffiliateProgram AffiliateProgram_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AffiliateProgram"
    ADD CONSTRAINT "AffiliateProgram_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AgentActivityLog AgentActivityLog_relatedContactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentActivityLog"
    ADD CONSTRAINT "AgentActivityLog_relatedContactId_fkey" FOREIGN KEY ("relatedContactId") REFERENCES public."Contact"(id) ON DELETE SET NULL;


--
-- Name: AgentActivityLog AgentActivityLog_relatedDealId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentActivityLog"
    ADD CONSTRAINT "AgentActivityLog_relatedDealId_fkey" FOREIGN KEY ("relatedDealId") REFERENCES public."Deal"(id) ON DELETE SET NULL;


--
-- Name: AgentActivityLog AgentActivityLog_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentActivityLog"
    ADD CONSTRAINT "AgentActivityLog_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AgentDraft AgentDraft_contactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentDraft"
    ADD CONSTRAINT "AgentDraft_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON DELETE CASCADE;


--
-- Name: AgentDraft AgentDraft_dealId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentDraft"
    ADD CONSTRAINT "AgentDraft_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES public."Deal"(id) ON DELETE SET NULL;


--
-- Name: AgentDraft AgentDraft_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentDraft"
    ADD CONSTRAINT "AgentDraft_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AgentGoal AgentGoal_contactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentGoal"
    ADD CONSTRAINT "AgentGoal_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON DELETE SET NULL;


--
-- Name: AgentGoal AgentGoal_dealId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentGoal"
    ADD CONSTRAINT "AgentGoal_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES public."Deal"(id) ON DELETE SET NULL;


--
-- Name: AgentGoal AgentGoal_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentGoal"
    ADD CONSTRAINT "AgentGoal_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AgentMemory AgentMemory_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentMemory"
    ADD CONSTRAINT "AgentMemory_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AgentMemory AgentMemory_taskId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentMemory"
    ADD CONSTRAINT "AgentMemory_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES public."AgentTask"(id) ON DELETE SET NULL;


--
-- Name: AgentPausedRun AgentPausedRun_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentPausedRun"
    ADD CONSTRAINT "AgentPausedRun_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AgentQuestion AgentQuestion_contactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentQuestion"
    ADD CONSTRAINT "AgentQuestion_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON DELETE SET NULL;


--
-- Name: AgentQuestion AgentQuestion_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentQuestion"
    ADD CONSTRAINT "AgentQuestion_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AgentSettings AgentSettings_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentSettings"
    ADD CONSTRAINT "AgentSettings_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AgentTask AgentTask_parentTaskId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentTask"
    ADD CONSTRAINT "AgentTask_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES public."AgentTask"(id) ON DELETE SET NULL;


--
-- Name: AgentTask AgentTask_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentTask"
    ADD CONSTRAINT "AgentTask_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AgentTrajectory AgentTrajectory_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentTrajectory"
    ADD CONSTRAINT "AgentTrajectory_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: AnnouncementDismissal AnnouncementDismissal_announcementId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AnnouncementDismissal"
    ADD CONSTRAINT "AnnouncementDismissal_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES public."Announcement"(id) ON DELETE CASCADE;


--
-- Name: ApplicationMessage ApplicationMessage_contactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ApplicationMessage"
    ADD CONSTRAINT "ApplicationMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON DELETE CASCADE;


--
-- Name: ApplicationMessage ApplicationMessage_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ApplicationMessage"
    ADD CONSTRAINT "ApplicationMessage_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: ApplicationStatusUpdate ApplicationStatusUpdate_contactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ApplicationStatusUpdate"
    ADD CONSTRAINT "ApplicationStatusUpdate_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON DELETE CASCADE;


--
-- Name: ApplicationStatusUpdate ApplicationStatusUpdate_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ApplicationStatusUpdate"
    ADD CONSTRAINT "ApplicationStatusUpdate_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: ArtifactVersion ArtifactVersion_artifactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ArtifactVersion"
    ADD CONSTRAINT "ArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES public."Artifact"(id) ON DELETE CASCADE;


--
-- Name: Artifact Artifact_currentVersionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Artifact"
    ADD CONSTRAINT "Artifact_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES public."ArtifactVersion"(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;


--
-- Name: Artifact Artifact_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Artifact"
    ADD CONSTRAINT "Artifact_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Artifact Artifact_stepId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Artifact"
    ADD CONSTRAINT "Artifact_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES public."ExecutionStep"(id) ON DELETE SET NULL;


--
-- Name: Artifact Artifact_taskId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Artifact"
    ADD CONSTRAINT "Artifact_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES public."AgentTask"(id) ON DELETE SET NULL;


--
-- Name: BriefTipHistory BriefTipHistory_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BriefTipHistory"
    ADD CONSTRAINT "BriefTipHistory_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Brief Brief_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Brief"
    ADD CONSTRAINT "Brief_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: CalendarEventMirror CalendarEventMirror_sourceDemoId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CalendarEventMirror"
    ADD CONSTRAINT "CalendarEventMirror_sourceDemoId_fkey" FOREIGN KEY ("sourceDemoId") REFERENCES public."Demo"(id) ON DELETE SET NULL;


--
-- Name: CalendarEventMirror CalendarEventMirror_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CalendarEventMirror"
    ADD CONSTRAINT "CalendarEventMirror_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: CalendarEvent CalendarEvent_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CalendarEvent"
    ADD CONSTRAINT "CalendarEvent_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: CalendarNote CalendarNote_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CalendarNote"
    ADD CONSTRAINT "CalendarNote_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: CallLog CallLog_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CallLog"
    ADD CONSTRAINT "CallLog_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: ChatUsage ChatUsage_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChatUsage"
    ADD CONSTRAINT "ChatUsage_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: ClientDocument ClientDocument_contactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientDocument"
    ADD CONSTRAINT "ClientDocument_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON DELETE CASCADE;


--
-- Name: ClientDocument ClientDocument_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientDocument"
    ADD CONSTRAINT "ClientDocument_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: ClientInfoRequest ClientInfoRequest_contactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientInfoRequest"
    ADD CONSTRAINT "ClientInfoRequest_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON DELETE CASCADE;


--
-- Name: ClientInfoRequest ClientInfoRequest_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientInfoRequest"
    ADD CONSTRAINT "ClientInfoRequest_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: ClientMessage ClientMessage_contactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientMessage"
    ADD CONSTRAINT "ClientMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON DELETE CASCADE;


--
-- Name: ClientMessage ClientMessage_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClientMessage"
    ADD CONSTRAINT "ClientMessage_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: CmaReport CmaReport_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CmaReport"
    ADD CONSTRAINT "CmaReport_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: CommissionLedger CommissionLedger_agentUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CommissionLedger"
    ADD CONSTRAINT "CommissionLedger_agentUserId_fkey" FOREIGN KEY ("agentUserId") REFERENCES public."User"(id) ON DELETE SET NULL;


--
-- Name: CommissionLedger CommissionLedger_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CommissionLedger"
    ADD CONSTRAINT "CommissionLedger_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE CASCADE;


--
-- Name: CommissionLedger CommissionLedger_dealId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CommissionLedger"
    ADD CONSTRAINT "CommissionLedger_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES public."Deal"(id) ON DELETE SET NULL;


--
-- Name: CommissionLedger CommissionLedger_referralUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CommissionLedger"
    ADD CONSTRAINT "CommissionLedger_referralUserId_fkey" FOREIGN KEY ("referralUserId") REFERENCES public."User"(id) ON DELETE SET NULL;


--
-- Name: CommissionSplit CommissionSplit_dealId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CommissionSplit"
    ADD CONSTRAINT "CommissionSplit_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES public."Deal"(id) ON DELETE CASCADE;


--
-- Name: CommissionSplit CommissionSplit_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CommissionSplit"
    ADD CONSTRAINT "CommissionSplit_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: CompanyIntegrationConnection CompanyIntegrationConnection_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyIntegrationConnection"
    ADD CONSTRAINT "CompanyIntegrationConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE CASCADE;


--
-- Name: CompanyMembership CompanyMembership_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyMembership"
    ADD CONSTRAINT "CompanyMembership_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE CASCADE;


--
-- Name: CompanyMembership CompanyMembership_invitedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyMembership"
    ADD CONSTRAINT "CompanyMembership_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES public."User"(id) ON DELETE SET NULL;


--
-- Name: CompanyMembership CompanyMembership_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyMembership"
    ADD CONSTRAINT "CompanyMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: CompanyRemoval CompanyRemoval_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyRemoval"
    ADD CONSTRAINT "CompanyRemoval_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE CASCADE;


--
-- Name: CompanyRemoval CompanyRemoval_removedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyRemoval"
    ADD CONSTRAINT "CompanyRemoval_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES public."User"(id) ON DELETE SET NULL;


--
-- Name: CompanyRemoval CompanyRemoval_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyRemoval"
    ADD CONSTRAINT "CompanyRemoval_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: CompanyTemplate CompanyTemplate_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyTemplate"
    ADD CONSTRAINT "CompanyTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE CASCADE;


--
-- Name: CompanyTemplate CompanyTemplate_createdByUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyTemplate"
    ADD CONSTRAINT "CompanyTemplate_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES public."User"(id) ON DELETE SET NULL;


--
-- Name: Company Company_lastAssignedUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Company"
    ADD CONSTRAINT "Company_lastAssignedUserId_fkey" FOREIGN KEY ("lastAssignedUserId") REFERENCES public."User"(id) ON DELETE SET NULL;


--
-- Name: Company Company_ownerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Company"
    ADD CONSTRAINT "Company_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."User"(id) ON DELETE RESTRICT;


--
-- Name: ContactDocument ContactDocument_contactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ContactDocument"
    ADD CONSTRAINT "ContactDocument_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON DELETE CASCADE;


--
-- Name: ContactDocument ContactDocument_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ContactDocument"
    ADD CONSTRAINT "ContactDocument_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Contact Contact_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Contact"
    ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE SET NULL;


--
-- Name: Contact Contact_sourceDemoId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Contact"
    ADD CONSTRAINT "Contact_sourceDemoId_fkey" FOREIGN KEY ("sourceDemoId") REFERENCES public."Demo"(id) ON DELETE SET NULL;


--
-- Name: Contact Contact_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Contact"
    ADD CONSTRAINT "Contact_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Conversation Conversation_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Conversation"
    ADD CONSTRAINT "Conversation_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: CustomAgent CustomAgent_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CustomAgent"
    ADD CONSTRAINT "CustomAgent_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: DealActivity DealActivity_dealId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealActivity"
    ADD CONSTRAINT "DealActivity_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES public."Deal"(id) ON DELETE CASCADE;


--
-- Name: DealActivity DealActivity_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealActivity"
    ADD CONSTRAINT "DealActivity_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: DealChecklistItem DealChecklistItem_dealId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealChecklistItem"
    ADD CONSTRAINT "DealChecklistItem_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES public."Deal"(id) ON DELETE CASCADE;


--
-- Name: DealChecklistItem DealChecklistItem_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealChecklistItem"
    ADD CONSTRAINT "DealChecklistItem_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: DealContact DealContact_contactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealContact"
    ADD CONSTRAINT "DealContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON DELETE CASCADE;


--
-- Name: DealContact DealContact_dealId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealContact"
    ADD CONSTRAINT "DealContact_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES public."Deal"(id) ON DELETE CASCADE;


--
-- Name: DealDocument DealDocument_dealId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealDocument"
    ADD CONSTRAINT "DealDocument_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES public."Deal"(id) ON DELETE CASCADE;


--
-- Name: DealDocument DealDocument_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealDocument"
    ADD CONSTRAINT "DealDocument_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: DealReviewComment DealReviewComment_authorUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealReviewComment"
    ADD CONSTRAINT "DealReviewComment_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: DealReviewComment DealReviewComment_reviewRequestId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealReviewComment"
    ADD CONSTRAINT "DealReviewComment_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES public."DealReviewRequest"(id) ON DELETE CASCADE;


--
-- Name: DealReviewRequest DealReviewRequest_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealReviewRequest"
    ADD CONSTRAINT "DealReviewRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE CASCADE;


--
-- Name: DealReviewRequest DealReviewRequest_dealId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealReviewRequest"
    ADD CONSTRAINT "DealReviewRequest_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES public."Deal"(id) ON DELETE CASCADE;


--
-- Name: DealReviewRequest DealReviewRequest_requestingUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealReviewRequest"
    ADD CONSTRAINT "DealReviewRequest_requestingUserId_fkey" FOREIGN KEY ("requestingUserId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: DealReviewRequest DealReviewRequest_resolvedByUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealReviewRequest"
    ADD CONSTRAINT "DealReviewRequest_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES public."User"(id) ON DELETE SET NULL;


--
-- Name: DealRoutingRule DealRoutingRule_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealRoutingRule"
    ADD CONSTRAINT "DealRoutingRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE CASCADE;


--
-- Name: DealRoutingRule DealRoutingRule_destinationUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealRoutingRule"
    ADD CONSTRAINT "DealRoutingRule_destinationUserId_fkey" FOREIGN KEY ("destinationUserId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: DealStage DealStage_pipelineId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealStage"
    ADD CONSTRAINT "DealStage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES public."Pipeline"(id) ON DELETE SET NULL;


--
-- Name: DealStage DealStage_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DealStage"
    ADD CONSTRAINT "DealStage_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Deal Deal_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Deal"
    ADD CONSTRAINT "Deal_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON DELETE SET NULL;


--
-- Name: Deal Deal_sourceDemoId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Deal"
    ADD CONSTRAINT "Deal_sourceDemoId_fkey" FOREIGN KEY ("sourceDemoId") REFERENCES public."Demo"(id) ON DELETE SET NULL;


--
-- Name: Deal Deal_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Deal"
    ADD CONSTRAINT "Deal_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Deal Deal_stageId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Deal"
    ADD CONSTRAINT "Deal_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES public."DealStage"(id) ON DELETE CASCADE;


--
-- Name: DemoAvailabilityOverride DemoAvailabilityOverride_productProfileId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DemoAvailabilityOverride"
    ADD CONSTRAINT "DemoAvailabilityOverride_productProfileId_fkey" FOREIGN KEY ("productProfileId") REFERENCES public."DemoProductProfile"(id) ON DELETE CASCADE;


--
-- Name: DemoAvailabilityOverride DemoAvailabilityOverride_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DemoAvailabilityOverride"
    ADD CONSTRAINT "DemoAvailabilityOverride_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: DemoFeedback DemoFeedback_demoId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DemoFeedback"
    ADD CONSTRAINT "DemoFeedback_demoId_fkey" FOREIGN KEY ("demoId") REFERENCES public."Demo"(id) ON DELETE CASCADE;


--
-- Name: DemoFeedback DemoFeedback_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DemoFeedback"
    ADD CONSTRAINT "DemoFeedback_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: DemoProductProfile DemoProductProfile_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DemoProductProfile"
    ADD CONSTRAINT "DemoProductProfile_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: DemoWaitlist DemoWaitlist_productProfileId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DemoWaitlist"
    ADD CONSTRAINT "DemoWaitlist_productProfileId_fkey" FOREIGN KEY ("productProfileId") REFERENCES public."DemoProductProfile"(id) ON DELETE SET NULL;


--
-- Name: DemoWaitlist DemoWaitlist_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DemoWaitlist"
    ADD CONSTRAINT "DemoWaitlist_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Demo Demo_contactId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Demo"
    ADD CONSTRAINT "Demo_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."Contact"(id) ON DELETE SET NULL;


--
-- Name: Demo Demo_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Demo"
    ADD CONSTRAINT "Demo_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON DELETE SET NULL;


--
-- Name: Demo Demo_productProfileId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Demo"
    ADD CONSTRAINT "Demo_productProfileId_fkey" FOREIGN KEY ("productProfileId") REFERENCES public."DemoProductProfile"(id) ON DELETE SET NULL;


--
-- Name: Demo Demo_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Demo"
    ADD CONSTRAINT "Demo_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: DisabledSpace DisabledSpace_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DisabledSpace"
    ADD CONSTRAINT "DisabledSpace_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: DocumentEmbedding DocumentEmbedding_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DocumentEmbedding"
    ADD CONSTRAINT "DocumentEmbedding_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: ExecutionStep ExecutionStep_taskId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ExecutionStep"
    ADD CONSTRAINT "ExecutionStep_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES public."AgentTask"(id) ON DELETE CASCADE;


--
-- Name: File File_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."File"
    ADD CONSTRAINT "File_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: FormAnalyticsEvent FormAnalyticsEvent_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FormAnalyticsEvent"
    ADD CONSTRAINT "FormAnalyticsEvent_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: FormDraft FormDraft_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FormDraft"
    ADD CONSTRAINT "FormDraft_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: GoalDecomposition GoalDecomposition_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GoalDecomposition"
    ADD CONSTRAINT "GoalDecomposition_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: GoalDecomposition GoalDecomposition_taskId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GoalDecomposition"
    ADD CONSTRAINT "GoalDecomposition_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES public."AgentTask"(id) ON DELETE CASCADE;


--
-- Name: GoogleCalendarToken GoogleCalendarToken_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GoogleCalendarToken"
    ADD CONSTRAINT "GoogleCalendarToken_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: IntegrationConnection IntegrationConnection_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IntegrationConnection"
    ADD CONSTRAINT "IntegrationConnection_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: IntegrationTrigger IntegrationTrigger_connectionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IntegrationTrigger"
    ADD CONSTRAINT "IntegrationTrigger_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES public."IntegrationConnection"(id) ON DELETE CASCADE;


--
-- Name: Invitation Invitation_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Invitation"
    ADD CONSTRAINT "Invitation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE CASCADE;


--
-- Name: Invitation Invitation_invitedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Invitation"
    ADD CONSTRAINT "Invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES public."User"(id) ON DELETE SET NULL;


--
-- Name: License License_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."License"
    ADD CONSTRAINT "License_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."MarketplaceOrder"(id) ON DELETE CASCADE;


--
-- Name: License License_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."License"
    ADD CONSTRAINT "License_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON DELETE CASCADE;


--
-- Name: ManagerConversation ManagerConversation_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ManagerConversation"
    ADD CONSTRAINT "ManagerConversation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE CASCADE;


--
-- Name: ManagerMessage ManagerMessage_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ManagerMessage"
    ADD CONSTRAINT "ManagerMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE CASCADE;


--
-- Name: ManagerMessage ManagerMessage_conversationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ManagerMessage"
    ADD CONSTRAINT "ManagerMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES public."ManagerConversation"(id) ON DELETE CASCADE;


--
-- Name: ManagerNotification ManagerNotification_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ManagerNotification"
    ADD CONSTRAINT "ManagerNotification_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE CASCADE;


--
-- Name: MarketplaceOrder MarketplaceOrder_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MarketplaceOrder"
    ADD CONSTRAINT "MarketplaceOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON DELETE CASCADE;


--
-- Name: MarketplaceOrder MarketplaceOrder_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MarketplaceOrder"
    ADD CONSTRAINT "MarketplaceOrder_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: McpApiKey McpApiKey_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."McpApiKey"
    ADD CONSTRAINT "McpApiKey_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: McpAuthCode McpAuthCode_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."McpAuthCode"
    ADD CONSTRAINT "McpAuthCode_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: MessageTemplate MessageTemplate_sourceTemplateId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageTemplate"
    ADD CONSTRAINT "MessageTemplate_sourceTemplateId_fkey" FOREIGN KEY ("sourceTemplateId") REFERENCES public."CompanyTemplate"(id) ON DELETE SET NULL;


--
-- Name: MessageTemplate MessageTemplate_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageTemplate"
    ADD CONSTRAINT "MessageTemplate_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Message Message_conversationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES public."Conversation"(id) ON DELETE CASCADE;


--
-- Name: Message Message_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Note Note_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Note"
    ADD CONSTRAINT "Note_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Pipeline Pipeline_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Pipeline"
    ADD CONSTRAINT "Pipeline_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: ProductPacket ProductPacket_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductPacket"
    ADD CONSTRAINT "ProductPacket_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON DELETE CASCADE;


--
-- Name: ProductPacket ProductPacket_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductPacket"
    ADD CONSTRAINT "ProductPacket_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: ProductView ProductView_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductView"
    ADD CONSTRAINT "ProductView_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON DELETE CASCADE;


--
-- Name: Product Product_assignedSpaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_assignedSpaceId_fkey" FOREIGN KEY ("assignedSpaceId") REFERENCES public."Space"(id) ON DELETE SET NULL;


--
-- Name: Product Product_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE SET NULL;


--
-- Name: Product Product_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: ProfilePage ProfilePage_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProfilePage"
    ADD CONSTRAINT "ProfilePage_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: PushSubscription PushSubscription_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PushSubscription"
    ADD CONSTRAINT "PushSubscription_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: ReferralClick ReferralClick_linkId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReferralClick"
    ADD CONSTRAINT "ReferralClick_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES public."ReferralLink"(id) ON DELETE CASCADE;


--
-- Name: ReferralLink ReferralLink_partnerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReferralLink"
    ADD CONSTRAINT "ReferralLink_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES public."AffiliatePartner"(id) ON DELETE CASCADE;


--
-- Name: ReferralLink ReferralLink_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReferralLink"
    ADD CONSTRAINT "ReferralLink_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON DELETE SET NULL;


--
-- Name: ReferralLink ReferralLink_programId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReferralLink"
    ADD CONSTRAINT "ReferralLink_programId_fkey" FOREIGN KEY ("programId") REFERENCES public."AffiliateProgram"(id) ON DELETE CASCADE;


--
-- Name: Referral Referral_linkId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Referral"
    ADD CONSTRAINT "Referral_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES public."ReferralLink"(id) ON DELETE CASCADE;


--
-- Name: Referral Referral_partnerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Referral"
    ADD CONSTRAINT "Referral_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES public."AffiliatePartner"(id) ON DELETE CASCADE;


--
-- Name: RefundRequest RefundRequest_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RefundRequest"
    ADD CONSTRAINT "RefundRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."MarketplaceOrder"(id) ON DELETE CASCADE;


--
-- Name: RefundRequest RefundRequest_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RefundRequest"
    ADD CONSTRAINT "RefundRequest_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Review Review_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Review"
    ADD CONSTRAINT "Review_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON DELETE CASCADE;


--
-- Name: Review Review_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Review"
    ADD CONSTRAINT "Review_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Routine Routine_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Routine"
    ADD CONSTRAINT "Routine_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: SignatureRequest SignatureRequest_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SignatureRequest"
    ADD CONSTRAINT "SignatureRequest_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: SpaceSetting SpaceSetting_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SpaceSetting"
    ADD CONSTRAINT "SpaceSetting_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: Space Space_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Space"
    ADD CONSTRAINT "Space_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON DELETE SET NULL;


--
-- Name: Space Space_ownerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Space"
    ADD CONSTRAINT "Space_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."User"(id) ON DELETE CASCADE;


--
-- Name: StripeBridge StripeBridge_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StripeBridge"
    ADD CONSTRAINT "StripeBridge_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: StudioBrand StudioBrand_headshotFileId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StudioBrand"
    ADD CONSTRAINT "StudioBrand_headshotFileId_fkey" FOREIGN KEY ("headshotFileId") REFERENCES public."File"(id) ON DELETE SET NULL;


--
-- Name: StudioBrand StudioBrand_logoFileId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StudioBrand"
    ADD CONSTRAINT "StudioBrand_logoFileId_fkey" FOREIGN KEY ("logoFileId") REFERENCES public."File"(id) ON DELETE SET NULL;


--
-- Name: StudioBrand StudioBrand_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StudioBrand"
    ADD CONSTRAINT "StudioBrand_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: StudioGeneration StudioGeneration_fileId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StudioGeneration"
    ADD CONSTRAINT "StudioGeneration_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES public."File"(id) ON DELETE SET NULL;


--
-- Name: StudioGeneration StudioGeneration_sourceFileId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StudioGeneration"
    ADD CONSTRAINT "StudioGeneration_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES public."File"(id) ON DELETE SET NULL;


--
-- Name: StudioGeneration StudioGeneration_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StudioGeneration"
    ADD CONSTRAINT "StudioGeneration_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: StudioPost StudioPost_fileId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StudioPost"
    ADD CONSTRAINT "StudioPost_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES public."File"(id) ON DELETE CASCADE;


--
-- Name: StudioPost StudioPost_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StudioPost"
    ADD CONSTRAINT "StudioPost_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: SupportTicket SupportTicket_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SupportTicket"
    ADD CONSTRAINT "SupportTicket_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE SET NULL;


--
-- Name: SwarmEvent SwarmEvent_memberId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SwarmEvent"
    ADD CONSTRAINT "SwarmEvent_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES public."SwarmMember"(id) ON DELETE SET NULL;


--
-- Name: SwarmEvent SwarmEvent_swarmRunId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SwarmEvent"
    ADD CONSTRAINT "SwarmEvent_swarmRunId_fkey" FOREIGN KEY ("swarmRunId") REFERENCES public."SwarmRun"(id) ON DELETE CASCADE;


--
-- Name: SwarmMember SwarmMember_customAgentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SwarmMember"
    ADD CONSTRAINT "SwarmMember_customAgentId_fkey" FOREIGN KEY ("customAgentId") REFERENCES public."CustomAgent"(id) ON DELETE SET NULL;


--
-- Name: SwarmMember SwarmMember_swarmRunId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SwarmMember"
    ADD CONSTRAINT "SwarmMember_swarmRunId_fkey" FOREIGN KEY ("swarmRunId") REFERENCES public."SwarmRun"(id) ON DELETE CASCADE;


--
-- Name: SwarmRun SwarmRun_spaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SwarmRun"
    ADD CONSTRAINT "SwarmRun_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public."Space"(id) ON DELETE CASCADE;


--
-- Name: TaskCheckpoint TaskCheckpoint_taskId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TaskCheckpoint"
    ADD CONSTRAINT "TaskCheckpoint_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES public."AgentTask"(id) ON DELETE CASCADE;


--
-- Name: TaskDependency TaskDependency_dependsOnTaskId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TaskDependency"
    ADD CONSTRAINT "TaskDependency_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES public."AgentTask"(id) ON DELETE CASCADE;


--
-- Name: TaskDependency TaskDependency_taskId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TaskDependency"
    ADD CONSTRAINT "TaskDependency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES public."AgentTask"(id) ON DELETE CASCADE;


--
-- Name: User User_offboardedToUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_offboardedToUserId_fkey" FOREIGN KEY ("offboardedToUserId") REFERENCES public."User"(id) ON DELETE SET NULL;


--
-- Name: AIUserProfile; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AIUserProfile" ENABLE ROW LEVEL SECURITY;

--
-- Name: AffiliateAccount; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AffiliateAccount" ENABLE ROW LEVEL SECURITY;

--
-- Name: AffiliateCommission; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AffiliateCommission" ENABLE ROW LEVEL SECURITY;

--
-- Name: AffiliatePartner; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AffiliatePartner" ENABLE ROW LEVEL SECURITY;

--
-- Name: AffiliatePayout; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AffiliatePayout" ENABLE ROW LEVEL SECURITY;

--
-- Name: AffiliateProgram; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AffiliateProgram" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentActivityLog; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentActivityLog" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentDraft; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentDraft" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentGoal; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentGoal" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentMemory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentMemory" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentPausedRun; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentPausedRun" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentQuestion; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentQuestion" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentSettings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentSettings" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentTask; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentTask" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentTrajectory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentTrajectory" ENABLE ROW LEVEL SECURITY;

--
-- Name: Announcement; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Announcement" ENABLE ROW LEVEL SECURITY;

--
-- Name: AnnouncementDismissal; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AnnouncementDismissal" ENABLE ROW LEVEL SECURITY;

--
-- Name: AppKnowledgeDoc; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AppKnowledgeDoc" ENABLE ROW LEVEL SECURITY;

--
-- Name: AppKnowledgeDoc AppKnowledgeDoc_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "AppKnowledgeDoc_read" ON public."AppKnowledgeDoc" FOR SELECT USING (true);


--
-- Name: ApplicationMessage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ApplicationMessage" ENABLE ROW LEVEL SECURITY;

--
-- Name: ApplicationStatusUpdate; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ApplicationStatusUpdate" ENABLE ROW LEVEL SECURITY;

--
-- Name: Artifact; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Artifact" ENABLE ROW LEVEL SECURITY;

--
-- Name: ArtifactVersion; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ArtifactVersion" ENABLE ROW LEVEL SECURITY;

--
-- Name: Attachment; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Attachment" ENABLE ROW LEVEL SECURITY;

--
-- Name: AuditLog; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AuditLog" ENABLE ROW LEVEL SECURITY;

--
-- Name: Brief; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Brief" ENABLE ROW LEVEL SECURITY;

--
-- Name: BriefTipHistory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."BriefTipHistory" ENABLE ROW LEVEL SECURITY;

--
-- Name: CalendarEvent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CalendarEvent" ENABLE ROW LEVEL SECURITY;

--
-- Name: CalendarEventMirror; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CalendarEventMirror" ENABLE ROW LEVEL SECURITY;

--
-- Name: CalendarNote; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CalendarNote" ENABLE ROW LEVEL SECURITY;

--
-- Name: CallLog; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CallLog" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChatUsage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChatUsage" ENABLE ROW LEVEL SECURITY;

--
-- Name: ClientAuthCode; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ClientAuthCode" ENABLE ROW LEVEL SECURITY;

--
-- Name: ClientDocument; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ClientDocument" ENABLE ROW LEVEL SECURITY;

--
-- Name: ClientInfoRequest; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ClientInfoRequest" ENABLE ROW LEVEL SECURITY;

--
-- Name: ClientMessage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ClientMessage" ENABLE ROW LEVEL SECURITY;

--
-- Name: ClientUser; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ClientUser" ENABLE ROW LEVEL SECURITY;

--
-- Name: CmaReport; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CmaReport" ENABLE ROW LEVEL SECURITY;

--
-- Name: CommissionLedger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CommissionLedger" ENABLE ROW LEVEL SECURITY;

--
-- Name: CommissionSplit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CommissionSplit" ENABLE ROW LEVEL SECURITY;

--
-- Name: Company; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Company" ENABLE ROW LEVEL SECURITY;

--
-- Name: CompanyIntegrationConnection; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CompanyIntegrationConnection" ENABLE ROW LEVEL SECURITY;

--
-- Name: CompanyMembership; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CompanyMembership" ENABLE ROW LEVEL SECURITY;

--
-- Name: CompanyRemoval; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CompanyRemoval" ENABLE ROW LEVEL SECURITY;

--
-- Name: CompanyTemplate; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CompanyTemplate" ENABLE ROW LEVEL SECURITY;

--
-- Name: Contact; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Contact" ENABLE ROW LEVEL SECURITY;

--
-- Name: ContactDocument; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ContactDocument" ENABLE ROW LEVEL SECURITY;

--
-- Name: Conversation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Conversation" ENABLE ROW LEVEL SECURITY;

--
-- Name: CreatorProfile; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CreatorProfile" ENABLE ROW LEVEL SECURITY;

--
-- Name: CreditLot; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CreditLot" ENABLE ROW LEVEL SECURITY;

--
-- Name: CreditTxn; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CreditTxn" ENABLE ROW LEVEL SECURITY;

--
-- Name: CustomAgent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CustomAgent" ENABLE ROW LEVEL SECURITY;

--
-- Name: DeadLetterEvent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DeadLetterEvent" ENABLE ROW LEVEL SECURITY;

--
-- Name: Deal; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Deal" ENABLE ROW LEVEL SECURITY;

--
-- Name: DealActivity; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DealActivity" ENABLE ROW LEVEL SECURITY;

--
-- Name: DealChecklistItem; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DealChecklistItem" ENABLE ROW LEVEL SECURITY;

--
-- Name: DealContact; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DealContact" ENABLE ROW LEVEL SECURITY;

--
-- Name: DealDocument; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DealDocument" ENABLE ROW LEVEL SECURITY;

--
-- Name: DealReviewComment; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DealReviewComment" ENABLE ROW LEVEL SECURITY;

--
-- Name: DealReviewRequest; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DealReviewRequest" ENABLE ROW LEVEL SECURITY;

--
-- Name: DealRoutingRule; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DealRoutingRule" ENABLE ROW LEVEL SECURITY;

--
-- Name: DealStage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DealStage" ENABLE ROW LEVEL SECURITY;

--
-- Name: Demo; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Demo" ENABLE ROW LEVEL SECURITY;

--
-- Name: DemoAvailabilityOverride; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DemoAvailabilityOverride" ENABLE ROW LEVEL SECURITY;

--
-- Name: DemoFeedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DemoFeedback" ENABLE ROW LEVEL SECURITY;

--
-- Name: DemoProductProfile; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DemoProductProfile" ENABLE ROW LEVEL SECURITY;

--
-- Name: DemoWaitlist; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DemoWaitlist" ENABLE ROW LEVEL SECURITY;

--
-- Name: DisabledSpace; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DisabledSpace" ENABLE ROW LEVEL SECURITY;

--
-- Name: DocumentEmbedding; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."DocumentEmbedding" ENABLE ROW LEVEL SECURITY;

--
-- Name: EmailBroadcast; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."EmailBroadcast" ENABLE ROW LEVEL SECURITY;

--
-- Name: EmailSuppression; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."EmailSuppression" ENABLE ROW LEVEL SECURITY;

--
-- Name: ExecutionStep; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ExecutionStep" ENABLE ROW LEVEL SECURITY;

--
-- Name: File; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."File" ENABLE ROW LEVEL SECURITY;

--
-- Name: FormAnalyticsEvent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."FormAnalyticsEvent" ENABLE ROW LEVEL SECURITY;

--
-- Name: FormDraft; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."FormDraft" ENABLE ROW LEVEL SECURITY;

--
-- Name: GoalDecomposition; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."GoalDecomposition" ENABLE ROW LEVEL SECURITY;

--
-- Name: GoogleCalendarToken; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."GoogleCalendarToken" ENABLE ROW LEVEL SECURITY;

--
-- Name: IntegrationConnection; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."IntegrationConnection" ENABLE ROW LEVEL SECURITY;

--
-- Name: IntegrationTrigger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."IntegrationTrigger" ENABLE ROW LEVEL SECURITY;

--
-- Name: Invitation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Invitation" ENABLE ROW LEVEL SECURITY;

--
-- Name: License; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."License" ENABLE ROW LEVEL SECURITY;

--
-- Name: ManagerConversation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ManagerConversation" ENABLE ROW LEVEL SECURITY;

--
-- Name: ManagerMessage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ManagerMessage" ENABLE ROW LEVEL SECURITY;

--
-- Name: ManagerNotification; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ManagerNotification" ENABLE ROW LEVEL SECURITY;

--
-- Name: MarketplaceOrder; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MarketplaceOrder" ENABLE ROW LEVEL SECURITY;

--
-- Name: McpApiKey; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."McpApiKey" ENABLE ROW LEVEL SECURITY;

--
-- Name: McpAuthCode; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."McpAuthCode" ENABLE ROW LEVEL SECURITY;

--
-- Name: Message; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Message" ENABLE ROW LEVEL SECURITY;

--
-- Name: MessageTemplate; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MessageTemplate" ENABLE ROW LEVEL SECURITY;

--
-- Name: Note; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Note" ENABLE ROW LEVEL SECURITY;

--
-- Name: Pipeline; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Pipeline" ENABLE ROW LEVEL SECURITY;

--
-- Name: Product; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Product" ENABLE ROW LEVEL SECURITY;

--
-- Name: ProductPacket; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ProductPacket" ENABLE ROW LEVEL SECURITY;

--
-- Name: ProductView; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ProductView" ENABLE ROW LEVEL SECURITY;

--
-- Name: ProfilePage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ProfilePage" ENABLE ROW LEVEL SECURITY;

--
-- Name: PushSubscription; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PushSubscription" ENABLE ROW LEVEL SECURITY;

--
-- Name: Referral; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Referral" ENABLE ROW LEVEL SECURITY;

--
-- Name: ReferralClick; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ReferralClick" ENABLE ROW LEVEL SECURITY;

--
-- Name: ReferralLink; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ReferralLink" ENABLE ROW LEVEL SECURITY;

--
-- Name: RefundRequest; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."RefundRequest" ENABLE ROW LEVEL SECURITY;

--
-- Name: Review; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Review" ENABLE ROW LEVEL SECURITY;

--
-- Name: Routine; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Routine" ENABLE ROW LEVEL SECURITY;

--
-- Name: SignatureRequest; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SignatureRequest" ENABLE ROW LEVEL SECURITY;

--
-- Name: Space; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Space" ENABLE ROW LEVEL SECURITY;

--
-- Name: SpaceSetting; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SpaceSetting" ENABLE ROW LEVEL SECURITY;

--
-- Name: StripeBridge; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."StripeBridge" ENABLE ROW LEVEL SECURITY;

--
-- Name: StudioBrand; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."StudioBrand" ENABLE ROW LEVEL SECURITY;

--
-- Name: StudioGeneration; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."StudioGeneration" ENABLE ROW LEVEL SECURITY;

--
-- Name: StudioPost; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."StudioPost" ENABLE ROW LEVEL SECURITY;

--
-- Name: SupportTicket; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SupportTicket" ENABLE ROW LEVEL SECURITY;

--
-- Name: SwarmEvent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SwarmEvent" ENABLE ROW LEVEL SECURITY;

--
-- Name: SwarmMember; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SwarmMember" ENABLE ROW LEVEL SECURITY;

--
-- Name: SwarmRun; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SwarmRun" ENABLE ROW LEVEL SECURITY;

--
-- Name: TaskCheckpoint; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."TaskCheckpoint" ENABLE ROW LEVEL SECURITY;

--
-- Name: TaskDependency; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."TaskDependency" ENABLE ROW LEVEL SECURITY;

--
-- Name: TelemetryEvent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."TelemetryEvent" ENABLE ROW LEVEL SECURITY;

--
-- Name: User; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentActivityLog agent_activity_log: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "agent_activity_log: space owner only" ON public."AgentActivityLog" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: AgentDraft agent_draft: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "agent_draft: space owner only" ON public."AgentDraft" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: AgentMemory agent_memory: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "agent_memory: space owner only" ON public."AgentMemory" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: AgentTask agent_task: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "agent_task: space owner only" ON public."AgentTask" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: AIUserProfile ai_user_profile: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "ai_user_profile: space owner only" ON public."AIUserProfile" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: Artifact artifact: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "artifact: space owner only" ON public."Artifact" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: ArtifactVersion artifact_version: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "artifact_version: space owner only" ON public."ArtifactVersion" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: ChatUsage chat_usage_owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY chat_usage_owner_read ON public."ChatUsage" FOR SELECT USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: Contact contact: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "contact: space owner only" ON public."Contact" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: CustomAgent custom_agent: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "custom_agent: space owner only" ON public."CustomAgent" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: DeadLetterEvent dead_letter_event: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "dead_letter_event: space owner only" ON public."DeadLetterEvent" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: Deal deal: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "deal: space owner only" ON public."Deal" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: DealContact deal_contact: via deal ownership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "deal_contact: via deal ownership" ON public."DealContact" USING (("dealId" IN ( SELECT d.id
   FROM (public."Deal" d
     JOIN public."Space" s ON ((s.id = d."spaceId")))
  WHERE (s."ownerId" = public.current_user_internal_id()))));


--
-- Name: DealStage deal_stage: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "deal_stage: space owner only" ON public."DealStage" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: DisabledSpace disabled_space: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "disabled_space: space owner only" ON public."DisabledSpace" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: DocumentEmbedding embedding: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "embedding: space owner only" ON public."DocumentEmbedding" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: ExecutionStep execution_step: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "execution_step: space owner only" ON public."ExecutionStep" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: File file_owner_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY file_owner_delete ON public."File" FOR DELETE USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: File file_owner_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY file_owner_insert ON public."File" FOR INSERT WITH CHECK (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: File file_owner_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY file_owner_select ON public."File" FOR SELECT USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: GoalDecomposition goal_decomposition: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "goal_decomposition: space owner only" ON public."GoalDecomposition" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: Message message: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "message: space owner only" ON public."Message" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: Space space: owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "space: owner only" ON public."Space" USING (("ownerId" = public.current_user_internal_id()));


--
-- Name: SpaceSetting space_setting: owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "space_setting: owner only" ON public."SpaceSetting" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: StudioBrand studio_brand: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "studio_brand: space owner only" ON public."StudioBrand" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: StudioGeneration studio_generation: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "studio_generation: space owner only" ON public."StudioGeneration" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: StudioPost studio_post: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "studio_post: space owner only" ON public."StudioPost" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: SwarmEvent swarm_event: via swarm run space owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "swarm_event: via swarm run space owner" ON public."SwarmEvent" USING ((EXISTS ( SELECT 1
   FROM public."SwarmRun" r
  WHERE ((r.id = "SwarmEvent"."swarmRunId") AND (r."spaceId" IN ( SELECT "Space".id
           FROM public."Space"
          WHERE ("Space"."ownerId" = public.current_user_internal_id())))))));


--
-- Name: SwarmMember swarm_member: via swarm run space owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "swarm_member: via swarm run space owner" ON public."SwarmMember" USING ((EXISTS ( SELECT 1
   FROM public."SwarmRun" r
  WHERE ((r.id = "SwarmMember"."swarmRunId") AND (r."spaceId" IN ( SELECT "Space".id
           FROM public."Space"
          WHERE ("Space"."ownerId" = public.current_user_internal_id())))))));


--
-- Name: SwarmRun swarm_run: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "swarm_run: space owner only" ON public."SwarmRun" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: TaskCheckpoint task_checkpoint: space owner only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "task_checkpoint: space owner only" ON public."TaskCheckpoint" USING (("spaceId" IN ( SELECT "Space".id
   FROM public."Space"
  WHERE ("Space"."ownerId" = public.current_user_internal_id()))));


--
-- Name: TaskDependency task_dependency: via task space owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "task_dependency: via task space owner" ON public."TaskDependency" USING ((EXISTS ( SELECT 1
   FROM public."AgentTask" t
  WHERE ((t.id = "TaskDependency"."taskId") AND (t."spaceId" IN ( SELECT "Space".id
           FROM public."Space"
          WHERE ("Space"."ownerId" = public.current_user_internal_id())))))));


--
-- Name: User user: own row only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "user: own row only" ON public."User" USING (("clerkId" = (auth.uid())::text));


--
-- PostgreSQL database dump complete
--

\unrestrict EGFHDQhj1HKfW8GsxteHye0IXbY9smqwCGPTszLR0xruEXtM23iMmYiBhIPcHhI

