import { notFound, redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import {
  H1,
  SECTION_LABEL,
  PAGE_RHYTHM,
  SECTION_RHYTHM,
} from '@/lib/typography';
import { getSpaceFromSlug, getSpaceForUser } from '@/lib/space';
import { getOrCreateDefaultProgram } from '@/lib/affiliates/programs';
import { getBridgeForSpace, bridgeWebhookUrl } from '@/lib/affiliates/stripe-bridge';
import { ProgramSettingsForm } from '@/components/affiliate/program-settings-form';
import { StripeBridgeCard } from '@/components/affiliate/stripe-bridge-card';

const AFFILIATE_TABS = [
  { label: 'Overview', href: '' },
  { label: 'Program', href: '/program' },
  { label: 'Commissions', href: '/commissions' },
  { label: 'Payouts', href: '/payouts' },
];

export default async function AffiliateProgramPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const space = await getSpaceFromSlug(slug);
  if (!space) notFound();

  const userSpace = await getSpaceForUser(userId);
  if (!userSpace || userSpace.id !== space.id) notFound();

  const [program, bridge] = await Promise.all([
    getOrCreateDefaultProgram(space.id),
    getBridgeForSpace(space.id),
  ]);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';

  return (
    <div className={cn(PAGE_RHYTHM)}>
      {/* Page header */}
      <header className="space-y-1">
        <p className={cn(SECTION_LABEL)}>Affiliates</p>
        <h1 className={cn(H1)}>
          Program settings
        </h1>
      </header>

      {/* Tab strip */}
      <nav className="flex items-center gap-0.5 border-b border-border/60 -mb-6">
        {AFFILIATE_TABS.map(({ label, href }) => {
          const isActive = href === '/program';
          return (
            <Link
              key={label}
              href={`/s/${slug}/affiliates${href}`}
              className={cn(
                'px-3.5 h-9 inline-flex items-center text-sm transition-colors border-b-2 -mb-px',
                isActive
                  ? 'border-primary text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Settings form */}
      <section className={cn(SECTION_RHYTHM)}>
        <ProgramSettingsForm
          slug={slug}
          initial={{
            name: program.name,
            commissionType: program.commissionType,
            commissionValue: program.commissionValue,
            cookieWindowDays: program.cookieWindowDays,
            autoApproveAffiliates: program.autoApproveAffiliates,
            autoApproveCommissions: program.autoApproveCommissions,
            recurring: program.recurring,
            recurringMonths: program.recurringMonths,
          }}
        />
      </section>

      {/* Seller's own-app Stripe bridge */}
      <section className={cn(SECTION_RHYTHM)}>
        <StripeBridgeCard
          initial={
            bridge
              ? {
                  id: bridge.id,
                  url: bridgeWebhookUrl(bridge.id, appUrl),
                  hasSecret: Boolean(bridge.webhookSecretEnc),
                  lastEventAt: bridge.lastEventAt,
                }
              : null
          }
        />
      </section>
    </div>
  );
}
