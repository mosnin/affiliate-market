import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { getLinkByCode } from '@/lib/affiliates/links';
import { getPartnerById } from '@/lib/affiliates/partners';
import { calculateCommissionCents, resolveCommissionPlan } from '@/lib/affiliates/commissions';
import { splitCommissionCents } from '@/lib/affiliates/fees';
import { sendCommissionEarnedEmail } from '@/lib/affiliates/emails';
import type { AffiliateProgramRow } from '@/lib/affiliates/programs';

export interface RecordConversionInput {
  orderId: string;
  spaceId: string;
  buyerEmail: string;
  amountCents: number;
  currency: string;
  referralCode: string | null;
  /** When set, the product's commission override (if any) applies. */
  productId?: string | null;
}

export interface ConversionResult {
  referralId: string;
  commissionCentsTotal: number;
}

/**
 * Attribute a paid order to an affiliate and create the commission.
 *
 * Rules (FirstPromoter semantics):
 * - last-click attribution within the program's cookie window; if no click
 *   was ever logged for the link we still honour the cookie code (clicks are
 *   best-effort client telemetry, the signed cookie is the source of truth)
 * - the link's program must belong to the order's space
 * - partner must be approved
 * - self-referrals (partner email == buyer email) are recorded as REJECTED
 *   commissions so the seller sees the attempt, and earn nothing
 * - commission status follows program.autoApproveCommissions
 *
 * Never throws — checkout must not fail because attribution did.
 */
export async function recordConversion(
  input: RecordConversionInput,
): Promise<ConversionResult | null> {
  try {
    if (!input.referralCode) return null;

    const link = await getLinkByCode(input.referralCode);
    if (!link) return null;

    const [partner, programRes] = await Promise.all([
      getPartnerById(link.partnerId),
      supabase.from('AffiliateProgram').select('*').eq('id', link.programId).maybeSingle(),
    ]);
    const program = (programRes.data as AffiliateProgramRow) ?? null;

    if (!partner || !program) return null;
    if (program.spaceId !== input.spaceId) {
      logger.warn('[affiliates] conversion code belongs to another space', {
        orderId: input.orderId,
      });
      return null;
    }
    if (partner.status !== 'approved') return null;

    // Attribution window: latest click for this link must fall inside the
    // program's cookie window — when clicks exist at all.
    const windowDays = program.cookieWindowDays ?? 30;
    const { data: lastClick } = await supabase
      .from('ReferralClick')
      .select('createdAt')
      .eq('linkId', link.id)
      .order('createdAt', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastClick) {
      const ageMs = Date.now() - new Date(lastClick.createdAt).getTime();
      if (ageMs > windowDays * 24 * 60 * 60 * 1000) {
        logger.info('[affiliates] conversion outside attribution window', {
          orderId: input.orderId,
          windowDays,
        });
        return null;
      }
    }

    const buyerEmail = input.buyerEmail.trim().toLowerCase();
    const selfReferral = partner.email.trim().toLowerCase() === buyerEmail;

    // Upsert the referral (one row per link+buyer).
    const { data: existingReferral } = await supabase
      .from('Referral')
      .select('id, firstClickAt')
      .eq('linkId', link.id)
      .ilike('buyerEmail', buyerEmail)
      .maybeSingle();

    let referralId: string;
    const convertedAt = new Date().toISOString();
    if (existingReferral) {
      referralId = existingReferral.id;
      await supabase
        .from('Referral')
        .update({ status: 'customer', orderId: input.orderId, convertedAt })
        .eq('id', referralId);
    } else {
      const { data: firstClick } = await supabase
        .from('ReferralClick')
        .select('createdAt')
        .eq('linkId', link.id)
        .order('createdAt', { ascending: true })
        .limit(1)
        .maybeSingle();
      const { data: referral, error: refErr } = await supabase
        .from('Referral')
        .insert({
          linkId: link.id,
          partnerId: partner.id,
          buyerEmail,
          orderId: input.orderId,
          status: 'customer',
          firstClickAt: firstClick?.createdAt ?? convertedAt,
          convertedAt,
        })
        .select('id')
        .single();
      if (refErr || !referral) {
        logger.warn('[affiliates] referral insert failed', { error: refErr?.message });
        return null;
      }
      referralId = referral.id;
    }

    // Per-product override beats the program default when set.
    let productOverride: { commissionType: string | null; commissionValue: number | null } | null = null;
    if (input.productId) {
      const { data: product } = await supabase
        .from('Product')
        .select('commissionType, commissionValue')
        .eq('id', input.productId)
        .maybeSingle();
      productOverride = (product as typeof productOverride) ?? null;
    }
    const plan = resolveCommissionPlan(program, productOverride);
    const commissionCents = calculateCommissionCents(plan, input.amountCents);
    const { platformFeeCents, netCents } = splitCommissionCents(commissionCents);
    const status = selfReferral
      ? 'rejected'
      : program.autoApproveCommissions
        ? 'approved'
        : 'pending';

    const { error: comErr } = await supabase.from('AffiliateCommission').insert({
      spaceId: input.spaceId,
      partnerId: partner.id,
      referralId,
      orderId: input.orderId,
      amountCents: commissionCents,
      platformFeeCents,
      netCents,
      currency: input.currency || 'usd',
      status,
      level: 1,
      note: selfReferral ? 'Self-referral — automatically rejected' : null,
      ...(status === 'approved' ? { approvedAt: convertedAt } : {}),
    });
    if (comErr) {
      logger.warn('[affiliates] commission insert failed', { error: comErr.message });
      return null;
    }

    if (selfReferral) {
      logger.info('[affiliates] self-referral rejected', { orderId: input.orderId });
      return null;
    }

    void sendCommissionEarnedEmail({
      to: partner.email,
      partnerName: partner.name,
      amountCents: netCents,
      pendingApproval: status === 'pending',
    });

    return { referralId, commissionCentsTotal: commissionCents };
  } catch (err) {
    logger.error('[affiliates] recordConversion failed', {
      orderId: input.orderId,
      err: String(err),
    });
    return null;
  }
}
