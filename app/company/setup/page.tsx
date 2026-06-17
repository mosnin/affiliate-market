import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { convex, api } from '@/lib/convex-server';
import { getManagerContext } from '@/lib/permissions';
import { CompanySetupClient } from './company-setup-client';

export const metadata = { title: 'Company — Cola' };

/**
 * /company setup page.
 * - If already a manager: redirect to /manager
 * - If not onboarded: redirect to /setup
 * - Otherwise: show create/join options
 */
export default async function CompanyPage() {
  const { userId } = await auth();
  if (!userId) redirect('/login/seller');

  const user = await convex().query(api.org.users.getByClerkId, { clerkId: userId });

  if (!user) redirect('/setup');
  if (!user.onboard) redirect('/setup');

  const space = await convex().query(api.workspace.spaces.getByOwnerId, {
    ownerId: user.id,
  });

  if (!space) redirect('/setup');

  // Already a manager? Go straight to the manager dashboard
  let existingCompanyName: string | null = null;
  let existingCompanyId: string | null = null;
  try {
    const ctx = await getManagerContext();
    if (ctx) {
      existingCompanyName = ctx.company.name;
      existingCompanyId = ctx.company.id;
    }
  } catch {
    // non-blocking
  }

  // Already a seller_member? Also redirect
  if (!existingCompanyName) {
    const sellerMemberships = await convex().query(api.org.memberships.listByUser, {
      userId: user.id,
      roles: ['seller_member'],
    });
    const membership = sellerMemberships[0] ?? null;
    if (membership) {
      const company = await convex().query(api.org.companies.getById, {
        id: membership.companyId,
      });
      existingCompanyName = company?.name ?? 'Your company';
      existingCompanyId = membership.companyId;
    }
  }

  return (
    <CompanySetupClient
      spaceSlug={space.slug}
      existingCompanyName={existingCompanyName}
      existingCompanyId={existingCompanyId}
    />
  );
}
