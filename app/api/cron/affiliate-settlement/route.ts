/**
 * GET /api/cron/affiliate-settlement
 *
 * Monthly (1st, 06:00 UTC — see vercel.json). Invoices every seller with
 * unsettled bridge commissions: the gross amounts their own-app sales owe
 * to creators (plus Cola's fee), charged automatically against the same
 * Stripe customer that pays their Cola subscription. Failures leave the
 * debt on the ledger — never written off, retried next run or settled
 * manually from the seller's payouts page.
 *
 * Auth: requires Authorization: Bearer <CRON_SECRET> header. Vercel Cron
 * injects this automatically when CRON_SECRET is set in project env vars.
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { listSpacesWithBridgeDebt, runBridgeSettlement } from '@/lib/affiliates/settlement';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const spaceIds = await listSpacesWithBridgeDebt();
  let invoiced = 0;
  let totalCents = 0;

  for (const spaceId of spaceIds) {
    const result = await runBridgeSettlement(spaceId);
    if (result) {
      invoiced += 1;
      totalCents += result.totalCents;
    }
  }

  logger.info('[cron/affiliate-settlement] complete', {
    sellersWithDebt: spaceIds.length,
    invoiced,
    totalCents,
  });
  return NextResponse.json({ sellersWithDebt: spaceIds.length, invoiced, totalCents });
}
