import { supabase } from '@/lib/supabase';

/**
 * Marketplace economics — the platform's take on GMV.
 *
 * Cola earns on every paid marketplace sale, separately from the 20% it
 * takes from creator commissions. The default rate is here; a per-space
 * override (Space.marketplaceFeeBps) lets the platform cut individual deals.
 *
 * Basis points: 1000 bps = 10%.
 */

export const DEFAULT_MARKETPLACE_FEE_BPS = 1000; // 10%

/** Resolve the GMV fee rate for a space (override → default). */
export async function getMarketplaceFeeBps(spaceId: string): Promise<number> {
  try {
    const { data } = await supabase
      .from('Space')
      .select('marketplaceFeeBps')
      .eq('id', spaceId)
      .maybeSingle();
    const override = data?.marketplaceFeeBps;
    if (typeof override === 'number' && override >= 0 && override <= 10000) return override;
  } catch {
    // fall through to default
  }
  return DEFAULT_MARKETPLACE_FEE_BPS;
}

/** Platform GMV fee in cents for a sale amount, rounded half-up. */
export function gmvFeeCents(amountCents: number, feeBps: number): number {
  const amount = Number(amountCents);
  const bps = Number(feeBps);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(bps) || bps <= 0) return 0;
  return Math.min(amount, Math.floor((amount * bps) / 10000 + 0.5));
}
