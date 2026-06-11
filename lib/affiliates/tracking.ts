import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { getLinkByCode } from '@/lib/affiliates/links';

/** Cookie that carries the referral code a visitor arrived with. */
export const REF_COOKIE = 'cola_ref';
/** Stable anonymous visitor id cookie (1 year). */
export const VISITOR_COOKIE = 'cola_vid';
/** Query params we accept referral codes from: ?via=CODE (FirstPromoter convention) or ?ref=CODE. */
export const REF_QUERY_PARAMS = ['via', 'ref'] as const;

export interface RecordClickInput {
  code: string;
  landingUrl: string;
  referrer: string | null;
  visitorId: string;
  ipHash: string | null;
  userAgent: string | null;
}

/**
 * Log a referral-link click. Returns false (without throwing) when the code
 * doesn't resolve to a link — unknown codes are noise, not errors.
 */
export async function recordClick(input: RecordClickInput): Promise<boolean> {
  try {
    const link = await getLinkByCode(input.code);
    if (!link) return false;

    const { error } = await supabase.from('ReferralClick').insert({
      linkId: link.id,
      visitorId: input.visitorId || null,
      ipHash: input.ipHash,
      userAgent: input.userAgent ? input.userAgent.slice(0, 512) : null,
      landingUrl: input.landingUrl ? input.landingUrl.slice(0, 2048) : null,
      referrer: input.referrer ? input.referrer.slice(0, 2048) : null,
    });

    if (error) {
      logger.warn('[affiliates] click insert failed', { error: error.message });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('[affiliates] recordClick failed', { err: String(err) });
    return false;
  }
}
