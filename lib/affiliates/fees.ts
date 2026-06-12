/**
 * Platform economics — one number, one place.
 *
 * Cola's revenue on the affiliate side is a flat 20% cut of creator
 * earnings: the seller owes the GROSS commission, the creator receives
 * NET, Cola keeps the difference. Buyers and sellers never see a fee
 * line; it comes out of the creator's side, like every creator platform
 * they already use.
 */

export const PLATFORM_FEE_PERCENT = 20;

export interface CommissionSplit {
  /** Cola's cut, in cents (rounded half-up). */
  platformFeeCents: number;
  /** What the creator is paid, in cents. */
  netCents: number;
}

/** Split a gross commission into platform fee + creator net. */
export function splitCommissionCents(grossCents: number): CommissionSplit {
  const gross = Number(grossCents);
  if (!Number.isFinite(gross) || gross <= 0) {
    return { platformFeeCents: 0, netCents: 0 };
  }
  const platformFeeCents = Math.floor((gross * PLATFORM_FEE_PERCENT) / 100 + 0.5);
  return { platformFeeCents, netCents: gross - platformFeeCents };
}
