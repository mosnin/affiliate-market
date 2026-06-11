-- Extend create_company_with_owner RPC to accept the new manager onboarding fields.

CREATE OR REPLACE FUNCTION create_company_with_owner(
  p_name                  TEXT,
  p_owner_id              TEXT,
  p_logo_url              TEXT DEFAULT NULL,
  p_website_url           TEXT DEFAULT NULL,
  p_office_address        TEXT DEFAULT NULL,
  p_office_phone          TEXT DEFAULT NULL,
  p_agent_count           TEXT DEFAULT NULL,
  p_company_type        TEXT DEFAULT NULL,
  p_primary_market        TEXT DEFAULT NULL,
  p_commission_structure  TEXT DEFAULT NULL,
  p_geographic_coverage   TEXT DEFAULT NULL
) RETURNS TEXT AS $$
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
$$ LANGUAGE plpgsql;
