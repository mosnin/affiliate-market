import { NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { getPartnerByUser } from '@/lib/affiliates/partners';
import { listLinksForPartner } from '@/lib/affiliates/links';
import { getAffiliateStats } from '@/lib/affiliates/stats';
import { listCommissionsForPartner } from '@/lib/affiliates/commissions';
import { getPayableBalanceCents } from '@/lib/affiliates/payouts';

/** The signed-in affiliate's own dashboard payload. */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress ?? null;

  const partner = await getPartnerByUser({ clerkUserId: userId, email });
  if (!partner) return NextResponse.json({ partner: null });

  const [links, stats, commissions, payableCents] = await Promise.all([
    listLinksForPartner(partner.id),
    getAffiliateStats(partner.id),
    listCommissionsForPartner(partner.id, 25),
    getPayableBalanceCents(partner.id),
  ]);

  return NextResponse.json({
    partner: {
      id: partner.id,
      name: partner.name,
      email: partner.email,
      status: partner.status,
    },
    links,
    stats,
    commissions,
    payableCents,
  });
}
