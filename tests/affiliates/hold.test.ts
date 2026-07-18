import { describe, expect, it } from 'vitest';
import { holdDaysFor, matureAtFor } from '@/lib/affiliates/programs';

describe('refund-hold maturity', () => {
  it('defaults to a 14-day hold when unset', () => {
    expect(holdDaysFor({})).toBe(14);
    expect(holdDaysFor({ holdDays: null })).toBe(14);
    expect(holdDaysFor({ holdDays: 30 })).toBe(30);
    expect(holdDaysFor({ holdDays: 0 })).toBe(0); // instant-pay is allowed
  });

  it('matureAt is roughly holdDays in the future', () => {
    const now = Date.now();
    const mature = new Date(matureAtFor({ holdDays: 7 })).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    // within a 5s tolerance of now + 7 days
    expect(Math.abs(mature - (now + sevenDays))).toBeLessThan(5000);
  });

  it('holdDays=0 makes the commission immediately mature', () => {
    const mature = new Date(matureAtFor({ holdDays: 0 })).getTime();
    expect(mature).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
