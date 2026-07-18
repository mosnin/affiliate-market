import { NextResponse } from 'next/server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import { getBridgeOwedCents, runBridgeSettlement } from '@/lib/affiliates/settlement';

/** What this seller currently owes for off-platform (bridge) commissions. */
export async function GET() {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const owedCents = await getBridgeOwedCents(result.space.id);
  return NextResponse.json({ owedCents });
}

/** Settle now: invoice the seller's saved payment method for the balance. */
export async function POST() {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const settlement = await runBridgeSettlement(result.space.id);
  if (!settlement) {
    const owedCents = await getBridgeOwedCents(result.space.id);
    return NextResponse.json(
      owedCents === 0
        ? { settled: false, owedCents, reason: 'Nothing to settle.' }
        : {
            settled: false,
            owedCents,
            reason:
              'Could not charge automatically — check that billing is set up. The balance stays on your ledger.',
          },
      { status: owedCents === 0 ? 200 : 502 },
    );
  }
  return NextResponse.json({ settled: true, ...settlement });
}
