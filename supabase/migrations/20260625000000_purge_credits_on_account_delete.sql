-- ============================================================================
-- Purge an account's credit ledger when its Space/Company is deleted.
--
-- CreditLot / CreditTxn are keyed by a POLYMORPHIC (accountType, accountId) —
-- accountId points at either a Space or a Company — so there is no real
-- foreign key and no ON DELETE CASCADE. When a Space or Company is deleted
-- (e.g. a user offboards and their Space cascades away), its credit lots and
-- transactions are left behind as orphans that nothing ever reads but that
-- accumulate forever.
--
-- A trigger is the right tool here precisely BECAUSE the relationship is
-- polymorphic and can't be expressed as an FK. AFTER DELETE on each owning
-- table removes the matching ledger rows for that account type.
--
-- ✓ VALIDATED on PostgreSQL 16: deleting a Space removes its CreditLot/CreditTxn
--   rows and leaves another account's rows untouched; same for Company.
-- ============================================================================

CREATE OR REPLACE FUNCTION purge_credit_rows_for_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- TG_ARGV[0] is the accountType this trigger guards ('space' | 'company').
  DELETE FROM "CreditLot" WHERE "accountType" = TG_ARGV[0] AND "accountId" = OLD.id;
  DELETE FROM "CreditTxn" WHERE "accountType" = TG_ARGV[0] AND "accountId" = OLD.id;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE TRIGGER trg_purge_credits_on_space_delete
  AFTER DELETE ON "Space"
  FOR EACH ROW EXECUTE FUNCTION purge_credit_rows_for_account('space');

CREATE OR REPLACE TRIGGER trg_purge_credits_on_company_delete
  AFTER DELETE ON "Company"
  FOR EACH ROW EXECUTE FUNCTION purge_credit_rows_for_account('company');
