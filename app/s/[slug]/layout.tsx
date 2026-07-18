import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@clerk/nextjs/server';
import { getSpaceFromSlug } from '@/lib/space';
import { Sidebar } from '@/components/dashboard/sidebar';
import { SidebarCollapseProvider } from '@/components/dashboard/sidebar-collapse';
import { MobileNav } from '@/components/dashboard/mobile-nav';
import { Header } from '@/components/dashboard/header';
import { convex, api } from '@/lib/convex-server';
import { ensureOnboardingBackfill } from '@/lib/onboarding';
import { getManagerContext } from '@/lib/permissions';
import { LiveNotifications } from '@/components/dashboard/live-notifications';
import { PlatformBanner } from '@/components/platform-banner';
import { CommandPalette } from '@/components/command-palette/command-palette';
import { ColaBar } from '@/components/cola/cola-bar';
import { EmbedDetector } from '@/components/cola/embed-detector';
import { LayoutShell } from '@/components/dashboard/layout-shell';
import { ColaSplash } from '@/components/dashboard/cola-splash';
import { pickGreeting } from '@/lib/greetings';
import { ReferralTracker } from '@/components/affiliate/referral-tracker';


export default async function DashboardLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { userId } = await auth();

  if (!userId) {
    redirect('/login/seller');
  }

  // Gate: user must exist in our DB. On DB error, render error UI
  // (NOT .catch(() => null) which caused redirect loops, NOT throw which
  // shows the generic "Application error" page).
  let dbUser: {
    id: string;
    name: string | null;
    onboard: boolean;
    isPlatformAdmin: boolean;
    space: { id: string } | null;
  } | null | undefined;
  try {
    const row = await convex().query(api.org.users.getByClerkId, { clerkId: userId });
    if (row) {
      const spaceRow = await convex().query(api.workspace.spaces.getByOwnerId, {
        ownerId: row.id,
      });
      dbUser = {
        id: row.id as string,
        name: (row.name as string | null) ?? null,
        onboard: row.onboard as boolean,
        isPlatformAdmin: row.platformRole === 'admin',
        space: spaceRow ? { id: spaceRow.id as string } : null,
      };
    } else {
      dbUser = null;
    }
  } catch (err) {
    console.error('[layout] DB query failed', { clerkId: userId, slug, error: err });
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center space-y-4 p-8">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t load your workspace. This is usually temporary.
          </p>
          <a
            href={`/s/${slug}`}
            className="inline-block px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </a>
        </div>
      </div>
    );
  }

  if (!dbUser) {
    redirect('/setup');
  }

  // Best-effort backfill: set onboard=true if user has a space but flag is false.
  try {
    await ensureOnboardingBackfill(dbUser);
  } catch (err) {
    console.error('[layout] backfill failed (non-blocking)', { clerkId: userId, slug, error: err });
  }

  let space;
  try {
    space = await getSpaceFromSlug(slug);
  } catch (err) {
    console.error('[layout] getSpaceFromSlug failed', { slug, error: err });
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center space-y-4 p-8">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t load your workspace. This is usually temporary.
          </p>
          <a
            href={`/s/${slug}`}
            className="inline-block px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </a>
        </div>
      </div>
    );
  }
  if (!space) notFound();

  // Security: ensure the authenticated user actually owns this workspace.
  // Without this check any logged-in user could visit /s/<other-user-slug>.
  if (!dbUser.space || dbUser.space.id !== space.id) notFound();

  // ── Subscription gate — redirect to standalone pages ────────────────
  // Exempt billing and settings pages so users can manage their subscription.
  // Use x-pathname from middleware; fall back to checking if the request
  // is for a known-exempt sub-path via the referer or just allow through
  // (the billing/settings pages themselves are safe to render).
  const headersList = await headers();
  // x-pathname is set by our middleware; x-invoke-path is set by Next.js internally
  const currentPath = headersList.get('x-pathname')
    || headersList.get('x-invoke-path')
    || headersList.get('x-matched-path')
    || headersList.get('next-url')
    || '';
  const isExemptPath =
    currentPath.includes('/billing') ||
    currentPath.includes('/settings');

  if (!dbUser.isPlatformAdmin) {
    try {
      const subData = await convex().query(api.workspace.spaces.getById, {
        id: space.id,
      });

      const status = subData?.stripeSubscriptionStatus ?? 'inactive';
      const hasSubscriptionHistory = !!(subData?.stripeSubscriptionId || subData?.trialUsedAt);

      if (status !== 'active' && status !== 'trialing') {
        // If on an exempt path (billing/settings) AND user has subscription history,
        // allow access so they can manage their billing/resubscribe.
        // Users with NO subscription history must NOT access exempt paths.
        if (isExemptPath && hasSubscriptionHistory) {
          // Allow through — user had a subscription before and needs billing access
        } else if (hasSubscriptionHistory) {
          redirect(`/billing-required?slug=${slug}&reason=${status}`);
        } else {
          // Never subscribed → show trial signup (even for billing/settings paths)
          redirect(`/subscribe?slug=${slug}`);
        }
      }
    } catch (err: any) {
      // Next.js redirect() throws a special error — re-throw it
      if (err?.digest?.startsWith('NEXT_REDIRECT')) throw err;
      // Fail secure: if anything goes wrong checking subscription, block access
      console.error('[layout] Subscription gate error:', err);
      redirect(`/subscribe?slug=${slug}`);
    }
  }

  let unreadLeadCount = 0;
  let overdueFollowUpCount = 0;
  let pendingDraftCount = 0;
  let activeProductCount = 0;
  try {
    const [leadCount, followUpCount, draftResult, productCount] = await Promise.all([
      convex().query(api.contacts.contacts.countForSpaces, {
        spaceIds: [space.id],
        requireCompanyIdNull: true,
        tagsAll: ['new-lead'],
      }),
      convex().query(api.contacts.contacts.countForSpaces, {
        spaceIds: [space.id],
        requireCompanyIdNull: true,
        followUpNotNull: true,
        followUpLte: new Date().toISOString(),
      }),
      convex()
        .query(api.agent.drafts.countBySpaceStatus, { spaceId: space.id, status: 'pending' })
        .then((count) => ({ count })),
      convex().query(api.marketplace.products.countForSpaceByStatus, {
        spaceId: space.id,
        listingStatusIn: ['active', 'pending'],
      }),
    ]);
    unreadLeadCount = leadCount ?? 0;
    overdueFollowUpCount = followUpCount ?? 0;
    pendingDraftCount = draftResult.count ?? 0;
    activeProductCount = productCount ?? 0;
  } catch {
    unreadLeadCount = 0;
    overdueFollowUpCount = 0;
    pendingDraftCount = 0;
    activeProductCount = 0;
  }

  // Check manager context and company memberships for sidebar
  let isManager = false;
  let companyName: string | null = null;
  let companyRole: string | null = null;
  let companyMemberships: { id: string; name: string; role: string }[] = [];
  try {
    // Memberships carry companyId only; compose the Company name with a second
    // read (cross-domain Company embed stays lib-side per the Convex contract).
    const memberships = await convex().query(api.org.memberships.listByUser, {
      userId: dbUser.id,
    });
    const companyIds = [...new Set(memberships.map((m) => m.companyId))];
    const companies = companyIds.length
      ? await convex().query(api.org.companies.listByIds, { ids: companyIds })
      : [];
    const nameById = new Map(companies.map((c) => [c.id, c.name]));

    companyMemberships = memberships
      .map((m) => ({ id: m.companyId, name: nameById.get(m.companyId) ?? null, role: m.role as string }))
      .filter((m): m is { id: string; name: string; role: string } => !!m.id && !!m.name);

    if (companyMemberships.length > 0) {
      isManager = companyMemberships.some(m => m.role === 'manager_owner' || m.role === 'manager_admin');
      companyName = companyMemberships[0].name;
      companyRole = companyMemberships[0].role;
    }
  } catch {
    isManager = false;
  }

  return (
    <div className="app-theme flex h-screen overflow-hidden bg-background text-foreground">
      {/* First-paint splash — greets the seller by name (varied each open),
          shows a snapshot of what's new, then dissolves into the dashboard.
          Plays every time the app/PWA is opened. */}
      <ColaSplash
        greeting={pickGreeting((dbUser.name ?? '').trim().split(/\s+/)[0] ?? '')}
        snapshot={{
          newLeads: unreadLeadCount,
          followUpsDue: overdueFollowUpCount,
          draftsReady: pendingDraftCount,
        }}
      />
      {/* Detects ?embed=1 from the Cola RightPanel iframe and strips
          sidebar/header/chat-bar via CSS. Mount near the root so the
          flag is set before any layout reads it. */}
      <EmbedDetector />
      {/* Collapse state is shared between the sidebar and the header's panel
          toggle, so the provider wraps both. */}
      <SidebarCollapseProvider>
        <Sidebar slug={slug} spaceName={space.name} unreadLeadCount={unreadLeadCount} pendingDraftCount={pendingDraftCount ?? 0} overdueFollowUpCount={overdueFollowUpCount} activeProductCount={activeProductCount} isManager={isManager} companyName={companyName} companyRole={companyRole} companyMemberships={companyMemberships} isPlatformAdmin={dbUser.isPlatformAdmin} />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <PlatformBanner />
          <Header slug={slug} spaceId={space.id} spaceName={space.name} title={space.name} isManager={isManager} companyName={companyName} isPlatformAdmin={dbUser.isPlatformAdmin} />
          <LayoutShell slug={slug} liveNotifications={<LiveNotifications spaceId={space.id} slug={slug} />}>
            {children}
          </LayoutShell>
        </div>
      </SidebarCollapseProvider>
      <MobileNav slug={slug} isManager={isManager} />
      <ColaBar slug={slug} />
      <CommandPalette slug={slug} />
      {/* Native referral attribution — captures ?via=/?ref= into the cola_ref
          cookie so a seller signing up through an affiliate link converts. */}
      <ReferralTracker />
    </div>
  );
}
