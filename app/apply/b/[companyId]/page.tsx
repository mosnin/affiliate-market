import { notFound } from 'next/navigation';
import { convex, api } from '@/lib/convex-server';
import { FormUnavailable } from '@/components/form-unavailable';
import { IntakeChat } from '@/components/intake-chat/intake-chat';
import { IntakeChatShell } from '@/components/intake-chat/intake-chat-shell';
import type { IntakeFormConfig } from '@/lib/types';
import type { Metadata } from 'next';

// Cache this page for 60 seconds — it's public and rarely changes.
export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ companyId: string }> }): Promise<Metadata> {
  const { companyId } = await params;
  const company = await convex().query(api.org.companies.getById, { id: companyId });

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
  const company = await convex().query(api.org.companies.getById, { id: companyId });

  if (!company || company.status === 'suspended') notFound();

  // 2. Find the manager_owner via CompanyMembership
  const ownerMemberships = await convex().query(api.org.memberships.listByCompany, {
    companyId: company.id,
    roles: ['manager_owner'],
  });
  const ownerMembership = ownerMemberships[0] ?? null;

  if (!ownerMembership) notFound();

  // 3. Get the company-linked owner Space for branding.
  // Space.ownerId is unique, so the owner has at most one space. Use it when
  // it's linked to this company; for legacy data (missing Space.companyId)
  // fall back to that same sole space.
  const ownerSpace = await convex().query(api.workspace.spaces.getByOwnerId, {
    ownerId: ownerMembership.userId,
  });

  let space = ownerSpace && ownerSpace.companyId === company.id ? ownerSpace : null;
  if (!space && ownerSpace) {
    // Legacy fallback: owner's sole space, regardless of companyId link.
    space = ownerSpace;
  }

  if (!space) notFound();

  // 4. Load company-level form configs so leads applying via the
  //    company URL see the company's customized intake (or the
  //    library defaults if the company hasn't customized). IntakeChat
  //    falls back to library defaults when all three are null.
  const companyConfigs = await convex().query(api.org.companies.getById, { id: company.id });

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
  const [settingsRow, ownerData] = await Promise.all([
    convex().query(api.workspace.settings.getBySpace, { spaceId: space.id }),
    convex().query(api.org.users.getById, { id: space.ownerId }),
  ]);

  const settingsData = { ...((settingsRow ?? {}) as any) };
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
    accentColor: settings?.intakeAccentColor || '#34c77f',
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
