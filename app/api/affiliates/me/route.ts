import { NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { getPartnersByUser } from '@/lib/affiliates/partners';
import { listLinksForPartners } from '@/lib/affiliates/links';
import { getAffiliateStatsForPartners } from '@/lib/affiliates/stats';
import { listCommissionsForPartner } from '@/lib/affiliates/commissions';
import { getPayableBalanceCentsForPartners } from '@/lib/affiliates/payouts';

/**
 * The signed-in creator's dashboard payload, aggregated across every seller
 * program they've joined (the explore flow can join many). Money figures
 * are creator NET — after the platform fee.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress ?? null;

  const partners = await getPartnersByUser({ clerkUserId: userId, email });
  if (partners.length === 0) return NextResponse.json({ partner: null, partners: [] });

  const approved = partners.filter((p) => p.status === 'approved');
  const partnerIds = approved.map((p) => p.id);
  const primary = approved[0] ?? partners[0];

  const [links, stats, commissions, payableCents] = await Promise.all([
    listLinksForPartners(partnerIds),
    getAffiliateStatsForPartners(partnerIds),
    primary ? listCommissionsForPartner(primary.id, 25) : Promise.resolve([]),
    getPayableBalanceCentsForPartners(partnerIds),
  ]);

  return NextResponse.json({
    // Back-compat single-partner shape + the full list.
    partner: {
      id: primary.id,
      name: primary.name,
      email: primary.email,
      status: primary.status,
    },
    partners: partners.map((p) => ({
      id: p.id,
      spaceId: p.spaceId,
      status: p.status,
      stripeConnected: Boolean(p.stripeAccountId),
    })),
    links,
    stats,
    commissions,
    payableCents,
  });
}
