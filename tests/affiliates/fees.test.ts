import { describe, expect, it } from 'vitest';
import { PLATFORM_FEE_PERCENT, splitCommissionCents } from '@/lib/affiliates/fees';

describe('splitCommissionCents — platform fee economics', () => {
  it('takes a flat 20% platform cut', () => {
    expect(PLATFORM_FEE_PERCENT).toBe(20);
    expect(splitCommissionCents(1000)).toEqual({ platformFeeCents: 200, netCents: 800 });
    expect(splitCommissionCents(2500)).toEqual({ platformFeeCents: 500, netCents: 2000 });
  });

  it('rounds the fee half-up and keeps fee + net === gross', () => {
    // 20% of 999 = 199.8 → 200
    expect(splitCommissionCents(999)).toEqual({ platformFeeCents: 200, netCents: 799 });
    // 20% of 1 = 0.2 → 0 (creator keeps the cent)
    expect(splitCommissionCents(1)).toEqual({ platformFeeCents: 0, netCents: 1 });
    for (const gross of [1, 3, 7, 99, 999, 12345]) {
      const { platformFeeCents, netCents } = splitCommissionCents(gross);
      expect(platformFeeCents + netCents).toBe(gross);
    }
  });

  it('clamps invalid input to zero', () => {
    expect(splitCommissionCents(0)).toEqual({ platformFeeCents: 0, netCents: 0 });
    expect(splitCommissionCents(-500)).toEqual({ platformFeeCents: 0, netCents: 0 });
    expect(splitCommissionCents(Number.NaN)).toEqual({ platformFeeCents: 0, netCents: 0 });
  });
});
