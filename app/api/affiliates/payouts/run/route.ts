import { NextResponse } from 'next/server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import { runPayoutBatch } from '@/lib/affiliates/payouts';
import { audit } from '@/lib/audit';

export async function POST() {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const payouts = await runPayoutBatch(result.space.id);
  const totalCents = payouts.reduce((sum, p) => sum + p.amountCents, 0);

  try {
    await audit({
      spaceId: result.space.id,
      actorClerkId: result.userId,
      action: 'PAYOUT',
      resource: 'affiliate_payout',
      metadata: { payouts: payouts.length, totalCents },
    });
  } catch {
    // Audit is best-effort; the payout itself already happened.
  }

  return NextResponse.json({ payouts, totalCents });
}
