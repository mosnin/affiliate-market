import { notFound } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { FormUnavailable } from '@/components/form-unavailable';
import { IntakeChat } from '@/components/intake-chat/intake-chat';
import { IntakeChatShell } from '@/components/intake-chat/intake-chat-shell';
import type { IntakeFormConfig } from '@/lib/types';
import type { Metadata } from 'next';

// Cache this page for 60 seconds — it's public and rarely changes.
export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ companyId: string }> }): Promise<Metadata> {
  const { companyId } = await params;
  const { data: company } = await supabase
    .from('Company')
    .select('name')
    .eq('id', companyId)
    .maybeSingle();

  const name = company?.name || 'Application';
  return {
    title: `${name} — Application`,
    description: `Submit your application to ${name}.`,
    openGraph: { title: `${name} — Application`, description: `Submit your application to ${name}.` },
  };
}

export default async function CompanyApplyPage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = await params;

  // 1. Look up the company
  const { data: company } = await supabase
    .from('Company')
    .select(
      'id, name, status, logoUrl, ' +
      'companyLicenseNumber, companyFairHousingNotice, companyShowEqualHousingMark'
    )
    .eq('id', companyId)
    .maybeSingle<{
      id: string;
      name: string;
      status: 'active' | 'suspended';
      logoUrl: string | null;
      companyLicenseNumber: string | null;
      companyFairHousingNotice: string | null;
      companyShowEqualHousingMark: boolean | null;
    }>();

  if (!company || company.status === 'suspended') notFound();

  // 2. Find the manager_owner via CompanyMembership
  const { data: ownerMembership } = await supabase
    .from('CompanyMembership')
    .select('userId')
    .eq('companyId', company.id)
    .eq('role', 'manager_owner')
    .maybeSingle();

  if (!ownerMembership) notFound();

  // 3. Get the company-linked owner Space for branding.
  // For legacy data (missing Space.companyId), fall back only when the
  // owner has exactly one space.
  const { data: linkedSpace } = await supabase
    .from('Space')
    .select('id, slug, name, ownerId, stripeSubscriptionStatus')
    .eq('ownerId', ownerMembership.userId)
    .eq('companyId', company.id)
    .maybeSingle();

  let space = linkedSpace;
  if (!space) {
    const { data: ownerSpaces } = await supabase
      .from('Space')
      .select('id, slug, name, ownerId, stripeSubscriptionStatus')
      .eq('ownerId', ownerMembership.userId)
      .order('createdAt', { ascending: true })
      .limit(2);
    const fallbackSpace = ownerSpaces?.[0] ?? null;
    if ((ownerSpaces ?? []).length === 1 && fallbackSpace) {
      space = fallbackSpace;
    }
  }

  if (!space) notFound();

  // 4. Load company-level form configs so leads applying via the
  //    company URL see the company's customized intake (or the
  //    library defaults if the company hasn't customized). IntakeChat
  //    falls back to library defaults when all three are null.
  const { data: companyConfigs } = await supabase
    .from('Company')
    .select('companyFormConfig, companyRentalFormConfig, companyBuyerFormConfig')
    .eq('id', company.id)
    .maybeSingle();

  const legacySingle = (companyConfigs?.companyFormConfig ?? null) as IntakeFormConfig | null;
  let resolvedRentalFormConfig =
    (companyConfigs?.companyRentalFormConfig ?? null) as IntakeFormConfig | null;
  let resolvedBuyerFormConfig =
    (companyConfigs?.companyBuyerFormConfig ?? null) as IntakeFormConfig | null;
  // Legacy single-config companies: route the config to the matching
  // leadType slot. Same compat logic /apply/[slug] uses.
  if (!resolvedRentalFormConfig && !resolvedBuyerFormConfig && legacySingle) {
    if (legacySingle.leadType === 'buyer') {
      resolvedBuyerFormConfig = legacySingle;
    } else {
      resolvedRentalFormConfig = legacySingle;
    }
  }

  // 5. Parallel queries for settings and owner info
  const [{ data: coreSettings }, { data: customSettings }, { data: ownerData }] = await Promise.all([
    supabase
      .from('SpaceSetting')
      .select('intakePageTitle, intakePageIntro, businessName, logoUrl, sellerPhotoUrl')
      .eq('spaceId', space.id)
      .maybeSingle(),
    supabase
      .from('SpaceSetting')
      .select(
        'intakeAccentColor, intakeBorderRadius, intakeFont, intakeDarkMode, ' +
        'intakeHeaderBgColor, intakeHeaderGradient, intakeVideoUrl, ' +
        'intakeDisclaimerText, intakeThankYouTitle, intakeThankYouMessage, ' +
        'intakeFooterLinks, intakeDisabledSteps, intakeCustomQuestions, ' +
        'intakeFaviconUrl, bio, socialLinks, privacyPolicyUrl, consentCheckboxLabel, ' +
        'intakeLicenseNumber, intakeFairHousingNotice, intakeShowEqualHousingMark'
      )
      .eq('spaceId', space.id)
      .maybeSingle()
      .then(r => r),
    supabase
      .from('User')
      .select('name, avatar')
      .eq('id', space.ownerId)
      .maybeSingle(),
  ]);

  const settingsData = { ...((coreSettings ?? {}) as any), ...((customSettings ?? {}) as any) };
  const settings = settingsData as {
    intakePageTitle: string | null;
    intakePageIntro: string | null;
    businessName: string | null;
    logoUrl: string | null;
    sellerPhotoUrl: string | null;
    intakeAccentColor: string | null;
    intakeBorderRadius: string | null;
    intakeFont: string | null;
    intakeDarkMode: boolean | null;
    intakeHeaderBgColor: string | null;
    intakeHeaderGradient: string | null;
    intakeVideoUrl: string | null;
    intakeDisclaimerText: string | null;
    intakeThankYouTitle: string | null;
    intakeThankYouMessage: string | null;
    intakeFooterLinks: { label: string; url: string }[] | null;
    intakeDisabledSteps: number[] | null;
    intakeCustomQuestions: { id: string; label: string; type: string; required?: boolean }[] | null;
    intakeFaviconUrl: string | null;
    bio: string | null;
    socialLinks: Record<string, string> | null;
    privacyPolicyUrl: string | null;
    consentCheckboxLabel: string | null;
    intakeLicenseNumber: string | null;
    intakeFairHousingNotice: string | null;
    intakeShowEqualHousingMark: boolean | null;
  } | null;

  // Use company name for title, fall back to space settings
  const pageTitle = `${company.name} Application`;
  const pageIntro = settings?.intakePageIntro || "Share your preferences and we'll follow up with next steps.";
  const businessName = company.name;
  const agentName = company.name;
  // For company forms, only show the logo — no circular avatar photo
  const agentPhoto = null;
  const logoUrl = company.logoUrl || settings?.logoUrl || null;

  // Gate on subscription status — only pause forms for explicitly failed billing
  const status = (space as any).stripeSubscriptionStatus as string | undefined;
  const formPaused = status === 'past_due' || status === 'canceled' || status === 'unpaid';
  if (formPaused) {
    return <FormUnavailable agentName={agentName} />;
  }

  // Hide the Cola mark on paid tiers — visible only on the free tier as
  // a value-exchange brand exposure. The company owner pays for white-label
  // when their linked space is on an active paid plan (or trialing into one).
  const hidePoweredBy = status === 'active' || status === 'trialing';

  const customization = {
    accentColor: settings?.intakeAccentColor || '#ff964f',
    borderRadius: settings?.intakeBorderRadius || 'rounded',
    font: settings?.intakeFont || 'system',
    darkMode: settings?.intakeDarkMode || false,
    headerBgColor: settings?.intakeHeaderBgColor || null,
    headerGradient: settings?.intakeHeaderGradient || null,
    videoUrl: settings?.intakeVideoUrl || null,
    disclaimerText: settings?.intakeDisclaimerText || null,
    thankYouTitle: settings?.intakeThankYouTitle || null,
    thankYouMessage: settings?.intakeThankYouMessage || null,
    footerLinks: settings?.intakeFooterLinks || [],
    disabledSteps: settings?.intakeDisabledSteps || [],
    customQuestions: settings?.intakeCustomQuestions || [],
    faviconUrl: settings?.intakeFaviconUrl || null,
    bio: null, // Don't show owner's personal bio on company forms
    socialLinks: settings?.socialLinks || null,
    privacyPolicyUrl: settings?.privacyPolicyUrl || `/apply/${(space as any).slug}/privacy`,
    consentCheckboxLabel: settings?.consentCheckboxLabel || null,
  };

  return (
    <IntakeChatShell
      businessName={businessName}
      agentName={agentName}
      agentPhoto={agentPhoto}
      coverPhotoUrl={null}
      logoUrl={logoUrl}
      isVerified={false}
      privacyPolicyUrl={customization.privacyPolicyUrl}
      hidePoweredBy={hidePoweredBy}
      footerLinks={customization.footerLinks}
      licenseNumber={company.companyLicenseNumber ?? settings?.intakeLicenseNumber ?? null}
      fairHousingNotice={company.companyFairHousingNotice ?? settings?.intakeFairHousingNotice ?? null}
      showEqualHousingMark={company.companyShowEqualHousingMark ?? settings?.intakeShowEqualHousingMark ?? false}
    >
      <IntakeChat
        slug={space.slug}
        spaceId={space.id}
        businessName={businessName}
        agentName={agentName}
        agentPhoto={agentPhoto}
        companyId={company.id}
        rentalFormConfig={resolvedRentalFormConfig}
        buyerFormConfig={resolvedBuyerFormConfig}
        formConfig={legacySingle}
        customization={{
          accentColor: customization.accentColor,
          thankYouTitle: customization.thankYouTitle,
          thankYouMessage: customization.thankYouMessage,
          privacyPolicyUrl: customization.privacyPolicyUrl,
        }}
      />
    </IntakeChatShell>
  );
}
