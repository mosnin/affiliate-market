import { describe, expect, it } from 'vitest';
import { gmvFeeCents, DEFAULT_MARKETPLACE_FEE_BPS } from '@/lib/marketplace/fees';

describe('gmvFeeCents — platform marketplace take', () => {
  it('default rate is 10%', () => {
    expect(DEFAULT_MARKETPLACE_FEE_BPS).toBe(1000);
    expect(gmvFeeCents(4900, 1000)).toBe(490); // $49 → $4.90
    expect(gmvFeeCents(10000, 1000)).toBe(1000);
  });

  it('rounds half-up and supports arbitrary bps', () => {
    expect(gmvFeeCents(999, 1000)).toBe(100); // 99.9 → 100
    expect(gmvFeeCents(4900, 500)).toBe(245); // 5% of $49
    expect(gmvFeeCents(4900, 0)).toBe(0); // 0% override = no fee
  });

  it('clamps invalid input and never exceeds the amount', () => {
    expect(gmvFeeCents(0, 1000)).toBe(0);
    expect(gmvFeeCents(-100, 1000)).toBe(0);
    expect(gmvFeeCents(100, -5)).toBe(0);
    expect(gmvFeeCents(100, 20000)).toBe(100); // 200% clamps to the amount
  });
});
