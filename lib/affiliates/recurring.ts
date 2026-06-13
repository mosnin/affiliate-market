import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { getLinkByCode } from '@/lib/affiliates/links';
import { getPartnerById, type AffiliatePartnerRow } from '@/lib/affiliates/partners';
import { calculateCommissionCents } from '@/lib/affiliates/commissions';
import { splitCommissionCents } from '@/lib/affiliates/fees';
import { sendCommissionEarnedEmail } from '@/lib/affiliates/emails';
import { maybeCreateTierTwoCommission } from '@/lib/affiliates/tier2';
import type { AffiliateProgramRow } from '@/lib/affiliates/programs';

/**
 * Recurring commission engine — turns verified Stripe payment events into
 * commissions, period after period.
 *
 * Period 1 is the sale itself. Whether later periods pay follows the
 * program: recurring off → one-time only; recurring on with
 * recurringMonths = N → periods 1..N; recurring on with no months set →
 * for as long as the customer keeps paying.
 */
export function isWithinRecurringWindow(
  program: { recurring: boolean; recurringMonths: number | null },
  periodNumber: number,
): boolean {
  if (periodNumber <= 1) return true;
  if (!program.recurring) return false;
  const months = program.recurringMonths;
  if (months == null || months <= 0) return true;
  return periodNumber <= months;
}

interface ResolvedReferral {
  referralId: string;
  partner: AffiliatePartnerRow;
  program: AffiliateProgramRow;
}

async function loadProgram(programId: string): Promise<AffiliateProgramRow | null> {
  const { data } = await supabase
    .from('AffiliateProgram')
    .select('*')
    .eq('id', programId)
    .maybeSingle();
  return (data as AffiliateProgramRow) ?? null;
}

/**
 * Find (or, on the code path, create) the referral a payment belongs to.
 * Resolution order:
 *  1. referral code (exact — from order.referralCode or Stripe metadata)
 *  2. buyer email matched against this space's existing referrals
 *     (FirstPromoter's "match sales by billing email")
 */
async function resolveReferral(input: {
  spaceId: string;
  code?: string | null;
  email?: string | null;
}): Promise<ResolvedReferral | null> {
  const email = input.email?.trim().toLowerCase() || null;

  if (input.code) {
    const link = await getLinkByCode(input.code);
    if (link) {
      const [partner, program] = await Promise.all([
        getPartnerById(link.partnerId),
        loadProgram(link.programId),
      ]);
      if (partner && program && program.spaceId === input.spaceId && partner.status === 'approved') {
        let referralQuery = supabase
          .from('Referral')
          .select('id')
          .eq('linkId', link.id)
          .order('createdAt', { ascending: false })
          .limit(1);
        if (email) referralQuery = referralQuery.ilike('buyerEmail', email);
        const { data: referral } = await referralQuery.maybeSingle();

        if (referral) return { referralId: referral.id, partner, program };

        // First payment we've seen for this link+buyer — create the referral.
        if (email) {
          const now = new Date().toISOString();
          const { data: created } = await supabase
            .from('Referral')
            .insert({
              linkId: link.id,
              partnerId: partner.id,
              buyerEmail: email,
              status: 'customer',
              firstClickAt: now,
              convertedAt: now,
            })
            .select('id')
            .single();
          if (created) return { referralId: created.id, partner, program };
        }
      }
    }
  }

  if (!email) return null;

  // Email match within the space.
  const { data: partners } = await supabase
    .from('AffiliatePartner')
    .select('id')
    .eq('spaceId', input.spaceId)
    .eq('status', 'approved');
  const partnerIds = (partners ?? []).map((p) => p.id);
  if (partnerIds.length === 0) return null;

  const { data: referral } = await supabase
    .from('Referral')
    .select('id, partnerId')
    .in('partnerId', partnerIds)
    .ilike('buyerEmail', email)
    .order('convertedAt', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (!referral) return null;

  const partner = await getPartnerById(referral.partnerId);
  if (!partner || partner.status !== 'approved') return null;
  const program = await loadProgram(partner.programId);
  if (!program || program.spaceId !== input.spaceId) return null;

  return { referralId: referral.id, partner, program };
}

export interface PaymentCommissionInput {
  spaceId: string;
  /** Stripe invoice id (or checkout-session id for one-time) — idempotency key. */
  stripeInvoiceId: string;
  amountCents: number;
  currency: string;
  buyerEmail: string | null;
  /** Exact attribution when known (order.referralCode, Stripe metadata cola_ref). */
  referralCode?: string | null;
  source: 'marketplace' | 'stripe_bridge';
  /** Marketplace order id when the payment maps to one. */
  orderId?: string | null;
}

/**
 * Record a commission for a VERIFIED payment event (first payment or
 * renewal — period math decides). Idempotent on stripeInvoiceId; never
 * throws. Returns null when the payment isn't attributable, is outside
 * the recurring window, or was already recorded.
 */
export async function recordPaymentCommission(
  input: PaymentCommissionInput,
): Promise<{ commissionCents: number; periodNumber: number } | null> {
  try {
    if (!input.stripeInvoiceId || input.amountCents <= 0) return null;

    // Idempotency: Stripe retries webhooks; one invoice pays once.
    const { data: existing } = await supabase
      .from('AffiliateCommission')
      .select('id')
      .eq('stripeInvoiceId', input.stripeInvoiceId)
      .maybeSingle();
    if (existing) return null;

    const resolved = await resolveReferral({
      spaceId: input.spaceId,
      code: input.referralCode,
      email: input.buyerEmail,
    });
    if (!resolved) return null;
    const { referralId, partner, program } = resolved;

    // Self-referral guard.
    if (
      input.buyerEmail &&
      partner.email.trim().toLowerCase() === input.buyerEmail.trim().toLowerCase()
    ) {
      logger.info('[affiliates] self-referral payment skipped', {
        invoice: input.stripeInvoiceId,
      });
      return null;
    }

    // Period = how many payments this referral has already earned on, plus one.
    const { count } = await supabase
      .from('AffiliateCommission')
      .select('id', { count: 'exact', head: true })
      .eq('referralId', referralId)
      .neq('status', 'rejected');
    const periodNumber = (count ?? 0) + 1;

    if (!isWithinRecurringWindow(program, periodNumber)) {
      logger.info('[affiliates] payment outside recurring window', {
        invoice: input.stripeInvoiceId,
        periodNumber,
        recurringMonths: program.recurringMonths,
      });
      return null;
    }

    const grossCents = calculateCommissionCents(program, input.amountCents);
    if (grossCents <= 0) return null;
    const { platformFeeCents, netCents } = splitCommissionCents(grossCents);
    const status = program.autoApproveCommissions ? 'approved' : 'pending';
    const now = new Date().toISOString();

    const { error } = await supabase.from('AffiliateCommission').insert({
      spaceId: input.spaceId,
      partnerId: partner.id,
      referralId,
      orderId: input.orderId ?? null,
      amountCents: grossCents,
      platformFeeCents,
      netCents,
      currency: input.currency || 'usd',
      status,
      level: 1,
      source: input.source,
      periodNumber,
      stripeInvoiceId: input.stripeInvoiceId,
      note: periodNumber > 1 ? `Subscription renewal — period ${periodNumber}` : null,
      ...(status === 'approved' ? { approvedAt: now } : {}),
    });
    if (error) {
      // Unique violation = a concurrent retry won the race; that's success.
      if (!`${error.message}`.toLowerCase().includes('duplicate')) {
        logger.warn('[affiliates] payment commission insert failed', {
          invoice: input.stripeInvoiceId,
          error: error.message,
        });
      }
      return null;
    }

    void sendCommissionEarnedEmail({
      to: partner.email,
      partnerName: partner.name,
      amountCents: netCents,
      pendingApproval: status === 'pending',
    });

    // Sub-affiliate override for whoever recruited this creator (level-2
    // piggybacks on this level-1's invoice idempotency — see tier2.ts).
    await maybeCreateTierTwoCommission({
      spaceId: input.spaceId,
      childPartnerId: partner.id,
      childGrossCents: grossCents,
      referralId,
      orderId: input.orderId ?? null,
      currency: input.currency,
      autoApprove: program.autoApproveCommissions,
    });

    return { commissionCents: grossCents, periodNumber };
  } catch (err) {
    logger.error('[affiliates] recordPaymentCommission failed', {
      invoice: input.stripeInvoiceId,
      err: String(err),
    });
    return null;
  }
}
