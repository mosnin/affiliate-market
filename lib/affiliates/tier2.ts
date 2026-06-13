import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { splitCommissionCents } from '@/lib/affiliates/fees';
import { sendCommissionEarnedEmail } from '@/lib/affiliates/emails';

/**
 * Second-tier override: when a recruited creator earns a level-1 commission,
 * their recruiter earns a level-2 commission worth `tier2Percent` of the
 * level-1 GROSS (the platform fee then splits off the recruiter's cut too).
 *
 * Idempotency: this piggybacks on the level-1 commission's idempotency. It's
 * only called after a level-1 row is successfully created, and the parent
 * row carries stripeInvoiceId = null so it never collides with the level-1
 * invoice-unique index nor confuses the level-1 idempotency lookup.
 *
 * Two tiers only — no recursion past the recruiter.
 */
export async function maybeCreateTierTwoCommission(input: {
  spaceId: string;
  childPartnerId: string;
  childGrossCents: number;
  referralId: string | null;
  orderId: string | null;
  currency: string;
  autoApprove: boolean;
}): Promise<void> {
  try {
    if (input.childGrossCents <= 0) return;

    const { data: child } = await supabase
      .from('AffiliatePartner')
      .select('parentPartnerId, programId, email')
      .eq('id', input.childPartnerId)
      .maybeSingle();
    const parentId = child?.parentPartnerId;
    if (!parentId) return;

    const { data: program } = await supabase
      .from('AffiliateProgram')
      .select('tier2Enabled, tier2Percent')
      .eq('id', child!.programId)
      .maybeSingle();
    if (!program?.tier2Enabled) return;
    const pct = Number(program.tier2Percent) || 0;
    if (pct <= 0) return;

    const { data: parent } = await supabase
      .from('AffiliatePartner')
      .select('id, name, email, status')
      .eq('id', parentId)
      .maybeSingle();
    if (!parent || parent.status !== 'approved') return;

    // Guard the obvious self-deal (recruiter == recruit by email).
    if (child!.email?.toLowerCase() === parent.email?.toLowerCase()) return;

    const grossCents = Math.floor((input.childGrossCents * pct) / 100 + 0.5);
    if (grossCents <= 0) return;
    const { platformFeeCents, netCents } = splitCommissionCents(grossCents);
    const now = new Date().toISOString();

    const { error } = await supabase.from('AffiliateCommission').insert({
      spaceId: input.spaceId,
      partnerId: parent.id,
      referralId: input.referralId,
      orderId: input.orderId,
      amountCents: grossCents,
      platformFeeCents,
      netCents,
      currency: input.currency || 'usd',
      status: input.autoApprove ? 'approved' : 'pending',
      level: 2,
      source: 'marketplace',
      note: 'Sub-affiliate override (tier 2)',
      ...(input.autoApprove ? { approvedAt: now } : {}),
    });
    if (error) {
      logger.warn('[affiliates] tier-2 commission insert failed', { error: error.message });
      return;
    }

    void sendCommissionEarnedEmail({
      to: parent.email,
      partnerName: parent.name,
      amountCents: netCents,
      pendingApproval: !input.autoApprove,
    });
  } catch (err) {
    logger.warn('[affiliates] maybeCreateTierTwoCommission threw', { err: String(err) });
  }
}
