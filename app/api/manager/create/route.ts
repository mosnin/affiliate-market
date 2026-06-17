import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/lib/audit';

/**
 * POST /api/manager/create
 * Self-serve company creation. Any authenticated, onboarded seller can create
 * one company. Enforced by the UNIQUE index on Company.ownerId.
 */
export async function POST(req: Request) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 3 attempts per user per day
  const { allowed } = await checkRateLimit(`manager:create:${clerkId}`, 3, 86400);
  if (!allowed) return NextResponse.json({ error: 'Too many attempts. Try again tomorrow.' }, { status: 429 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, logoUrl, websiteUrl, officeAddress, officePhone, agentCount, companyType, primaryMarket, commissionStructure, geographicCoverage } = body as {
    name?: string;
    logoUrl?: string;
    websiteUrl?: string;
    officeAddress?: string;
    officePhone?: string;
    agentCount?: string;
    companyType?: string;
    primaryMarket?: string;
    commissionStructure?: string;
    geographicCoverage?: string;
  };

  const trimmedName = (typeof name === 'string' ? name : '').trim();
  if (!trimmedName || trimmedName.length > 120) {
    return NextResponse.json({ error: 'Company name required (max 120 chars)' }, { status: 400 });
  }

  // Validate enum fields
  const validCompanyTypes = ['independent', 'franchise', 'virtual'];
  const validMarkets = ['residential_rental', 'commercial', 'mixed'];
  const validCommissions = ['flat_fee', 'percentage_split', 'hybrid'];
  if (companyType && !validCompanyTypes.includes(companyType)) {
    return NextResponse.json({ error: `Invalid companyType. Must be one of: ${validCompanyTypes.join(', ')}` }, { status: 400 });
  }
  if (primaryMarket && !validMarkets.includes(primaryMarket)) {
    return NextResponse.json({ error: `Invalid primaryMarket. Must be one of: ${validMarkets.join(', ')}` }, { status: 400 });
  }
  if (commissionStructure && !validCommissions.includes(commissionStructure)) {
    return NextResponse.json({ error: `Invalid commissionStructure. Must be one of: ${validCommissions.join(', ')}` }, { status: 400 });
  }

  // Resolve internal user id
  let user;
  try {
    user = await convex().query(api.org.users.getByClerkId, { clerkId });
  } catch {
    user = null;
  }
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  // Platform admins bypass the onboarding/account-type gates below. An admin is
  // usually a seller who was promoted, so their accountType is 'seller' — which
  // was tripping the "upgrade to a manager account" 403 and blocking them from
  // creating companies at all. Admins are superusers; let them through.
  const isAdmin = user.platformRole === 'admin';

  // Manager-only users are marked onboard during setup even without a Space
  if (!user.onboard && !isAdmin) return NextResponse.json({ error: 'Complete onboarding first' }, { status: 403 });
  // Only users who selected manager role during onboarding can create a company
  if (user.accountType === 'seller' && !isAdmin) {
    return NextResponse.json({ error: 'Upgrade to a manager account to create a company' }, { status: 403 });
  }

  // Create the company AND the owner membership atomically. The one-company-
  // per-owner invariant + the create/membership rollback are both handled inside
  // createWithOwner: it returns 'owner_taken' (no write) if the owner already has
  // a company, and a failed membership insert rolls the company back for free.
  const companyId = crypto.randomUUID();

  let result;
  try {
    result = await convex().mutation(api.org.companies.createWithOwner, {
      id: companyId,
      name: trimmedName,
      ownerId: user.id,
      logoUrl: logoUrl ? String(logoUrl).slice(0, 500) : undefined,
      websiteUrl: websiteUrl ? String(websiteUrl).slice(0, 500) : undefined,
      officeAddress: officeAddress ? String(officeAddress).slice(0, 500) : undefined,
      officePhone: officePhone ? String(officePhone).slice(0, 40) : undefined,
      agentCount: agentCount ? String(agentCount).slice(0, 20) : undefined,
      companyType: companyType as 'independent' | 'franchise' | 'virtual' | undefined,
      primaryMarket: primaryMarket as 'residential_rental' | 'commercial' | 'mixed' | undefined,
      commissionStructure: commissionStructure as
        | 'flat_fee'
        | 'percentage_split'
        | 'hybrid'
        | undefined,
      geographicCoverage: geographicCoverage ? String(geographicCoverage).slice(0, 500) : undefined,
    });
  } catch (err) {
    console.error('[manager/create] Company create failed:', err);
    return NextResponse.json({ error: 'Failed to create company' }, { status: 500 });
  }

  if (result.outcome === 'owner_taken') {
    return NextResponse.json({ error: 'You already own a company' }, { status: 409 });
  }

  void audit({ actorClerkId: clerkId, action: 'CREATE', resource: 'Company', resourceId: companyId, metadata: { name: trimmedName } });

  return NextResponse.json({ company: result.company }, { status: 201 });
}
