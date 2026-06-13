/**
 * GET /api/cron/affiliate-digests
 *
 * Weekly (Mon 09:00 UTC — see vercel.json). Emails both sides their last-7-days:
 *   - each seller with program activity → sales, revenue, new + pending creators
 *   - each creator with activity → clicks, customers, net earned
 * Zero-activity recipients are skipped (no "you did nothing" emails).
 *
 * Auth: Authorization: Bearer <CRON_SECRET>, injected by Vercel Cron.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import {
  listActiveSpacesForDigest,
  getSellerWeekly,
  getCreatorWeekly,
} from '@/lib/affiliates/digests';
import { sendSellerWeeklyDigest, sendCreatorWeeklyDigest } from '@/lib/affiliates/emails';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const spaceIds = await listActiveSpacesForDigest();
  let sellerEmails = 0;
  let creatorEmails = 0;

  for (const spaceId of spaceIds) {
    // Seller digest.
    const weekly = await getSellerWeekly(spaceId);
    if (weekly.sales > 0 || weekly.newPartners > 0 || weekly.pendingPartners > 0) {
      const { data: space } = await supabase
        .from('Space')
        .select('name, ownerId')
        .eq('id', spaceId)
        .maybeSingle();
      if (space?.ownerId) {
        const { data: owner } = await supabase
          .from('User')
          .select('email')
          .eq('id', space.ownerId)
          .maybeSingle();
        if (owner?.email) {
          void sendSellerWeeklyDigest({ to: owner.email, spaceName: space.name ?? 'Your workspace', ...weekly });
          sellerEmails += 1;
        }
      }
    }
  }

  // Creator digests — group partner rows by email (one person, many programs).
  const { data: partners } = await supabase
    .from('AffiliatePartner')
    .select('id, name, email')
    .eq('status', 'approved');
  const byEmail = new Map<string, { name: string; ids: string[] }>();
  for (const p of partners ?? []) {
    const key = p.email.toLowerCase();
    const entry = byEmail.get(key) ?? { name: p.name, ids: [] as string[] };
    entry.ids.push(p.id);
    byEmail.set(key, entry);
  }

  for (const [email, { name, ids }] of byEmail) {
    const weekly = await getCreatorWeekly(ids);
    if (weekly.clicks > 0 || weekly.customers > 0 || weekly.earnedNetCents > 0) {
      void sendCreatorWeeklyDigest({ to: email, partnerName: name, ...weekly });
      creatorEmails += 1;
    }
  }

  logger.info('[cron/affiliate-digests] complete', { spaces: spaceIds.length, sellerEmails, creatorEmails });
  return NextResponse.json({ spaces: spaceIds.length, sellerEmails, creatorEmails });
}
