import { getManagerContext } from '@/lib/permissions';
import { redirect } from 'next/navigation';
import { CompanySettingsForm } from '@/components/manager/settings-form';
import { CompanyIntakeTrustSignalsForm } from '@/components/manager/intake-trust-signals-form';
import {
  H1,
  TITLE_FONT,
  BODY_MUTED,
  SECTION_LABEL,
  SECTION_RHYTHM,
  READING_MAX,
} from '@/lib/typography';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'General settings — Teams' };

/**
 * Manager settings — general workspace identity (name, logo, website, privacy
 * policy) and the intake-form trust signals (license, fair-housing notice).
 *
 * The manager dashboard ships its own settings sub-nav (MCP, Auto-Assignment,
 * Routing rules, Billing) via `managerSettingsNavSections` in the sidebar, so
 * this page is the "General" leaf. Same Cola vocabulary as the seller
 * settings page: serif h1 + status sentence, hairline inputs, divide-y
 * sections, PRIMARY_PILL save.
 */
export default async function ManagerSettingsPage() {
  const ctx = await getManagerContext();
  if (!ctx) redirect('/');

  const { company, membership } = ctx;
  const canEdit = membership.role === 'manager_owner' || membership.role === 'manager_admin';

  const subtitle = canEdit
    ? `${company.name} — your company identity and intake settings.`
    : `${company.name} — read-only for your role.`;

  return (
    <div className={`${SECTION_RHYTHM} ${READING_MAX} pb-56 md:pb-24`}>
      <header className="space-y-1.5">
        <p className={BODY_MUTED}>Settings.</p>
        <h1 className={H1} style={TITLE_FONT}>
          General
        </h1>
        <p className={BODY_MUTED}>{subtitle}</p>
      </header>

      <section className="space-y-5">
        <p className={SECTION_LABEL}>Company</p>
        <CompanySettingsForm
          name={company.name}
          websiteUrl={company.websiteUrl}
          logoUrl={company.logoUrl}
          joinCode={company.joinCode}
          privacyPolicyHtml={company.privacyPolicyHtml ?? null}
          isOwner={canEdit}
        />
      </section>

      <section className="space-y-5 pt-10 border-t border-border/60">
        <p className={SECTION_LABEL}>Compliance &amp; trust signals</p>
        <p className={BODY_MUTED}>
          License number and compliance notices — shown in the company
          quote-request form footer for every seller on your team.
        </p>
        <CompanyIntakeTrustSignalsForm
          licenseNumber={company.companyLicenseNumber ?? ''}
          fairHousingNotice={company.companyFairHousingNotice ?? ''}
          showEqualHousingMark={company.companyShowEqualHousingMark ?? false}
          isOwner={canEdit}
        />
      </section>

      {!canEdit && (
        <p className={BODY_MUTED}>
          Only the company owner or admins can edit settings.
        </p>
      )}
    </div>
  );
}
