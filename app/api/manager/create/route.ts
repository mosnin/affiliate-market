import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
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
  const { data: user, error: userErr } = await supabase
    .from('User')
    .select('id, onboard, accountType, platformRole')
    .eq('clerkId', clerkId)
    .maybeSingle();
  if (userErr || !user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

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

  // Check: does this user already own a company?
  const { data: existing } = await supabase
    .from('Company')
    .select('id')
    .eq('ownerId', user.id)
    .maybeSingle();
  if (existing) return NextResponse.json({ error: 'You already own a company' }, { status: 409 });

  // Direct inserts instead of RPC — avoids ambiguous function overload issues
  // when multiple versions of create_company_with_owner exist in the database.
  const companyId = crypto.randomUUID();

  const { data: company, error: insertErr } = await supabase
    .from('Company')
    .insert({
      id: companyId,
      name: trimmedName,
      ownerId: user.id,
      ...(logoUrl && { logoUrl: String(logoUrl).slice(0, 500) }),
      ...(websiteUrl && { websiteUrl: String(websiteUrl).slice(0, 500) }),
      ...(officeAddress && { officeAddress: String(officeAddress).slice(0, 500) }),
      ...(officePhone && { officePhone: String(officePhone).slice(0, 40) }),
      ...(agentCount && { agentCount: String(agentCount).slice(0, 20) }),
      ...(companyType && { companyType }),
      ...(primaryMarket && { primaryMarket }),
      ...(commissionStructure && { commissionStructure }),
      ...(geographicCoverage && { geographicCoverage: String(geographicCoverage).slice(0, 500) }),
    })
    .select()
    .single();

  if (insertErr) {
    // Check if user already owns a company (race condition with unique index)
    const errMsg = insertErr.message || '';
    if (errMsg.includes('duplicate key') || errMsg.includes('unique') || insertErr.code === '23505') {
      return NextResponse.json({ error: 'You already own a company' }, { status: 409 });
    }
    console.error('[manager/create] Company insert failed:', insertErr);
    return NextResponse.json({ error: 'Failed to create company' }, { status: 500 });
  }

  // Create the owner membership
  const { error: membershipErr } = await supabase
    .from('CompanyMembership')
    .insert({
      id: crypto.randomUUID(),
      companyId,
      userId: user.id,
      role: 'manager_owner',
    });

  if (membershipErr) {
    console.error('[manager/create] CompanyMembership insert failed:', membershipErr);
    // Rollback: delete the company we just created since it's unusable without an owner membership
    await supabase.from('Company').delete().eq('id', companyId);
    return NextResponse.json({ error: 'Failed to create company membership' }, { status: 500 });
  }

  void audit({ actorClerkId: clerkId, action: 'CREATE', resource: 'Company', resourceId: companyId, metadata: { name: trimmedName } });

  return NextResponse.json({ company }, { status: 201 });
}
