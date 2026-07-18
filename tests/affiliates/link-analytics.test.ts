import { describe, expect, it } from 'vitest';
import { formatConversionRate } from '@/lib/affiliates/link-analytics';

describe('formatConversionRate', () => {
  it('shows whole percent at/above 10%', () => {
    expect(formatConversionRate(0.25)).toBe('25%');
    expect(formatConversionRate(0.1)).toBe('10%');
    expect(formatConversionRate(1)).toBe('100%');
  });

  it('shows one decimal below 10% (small rates still read as nonzero)', () => {
    expect(formatConversionRate(0.034)).toBe('3.4%');
    expect(formatConversionRate(0.005)).toBe('0.5%');
    expect(formatConversionRate(0)).toBe('0.0%');
  });
});
