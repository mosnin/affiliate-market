import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { supabase } from '@/lib/supabase';
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

  const { data: user } = await supabase
    .from('User')
    .select('id, onboard')
    .eq('clerkId', userId)
    .maybeSingle();

  if (!user) redirect('/setup');
  if (!user.onboard) redirect('/setup');

  const { data: space } = await supabase
    .from('Space')
    .select('slug')
    .eq('ownerId', user.id)
    .maybeSingle();

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
    const { data: membership } = await supabase
      .from('CompanyMembership')
      .select('companyId')
      .eq('userId', user.id)
      .eq('role', 'seller_member')
      .maybeSingle();
    if (membership) {
      const { data: company } = await supabase
        .from('Company')
        .select('name')
        .eq('id', membership.companyId)
        .maybeSingle();
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
