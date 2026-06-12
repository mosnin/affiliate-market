import { describe, expect, it } from 'vitest';
import { isWithinRecurringWindow } from '@/lib/affiliates/recurring';

describe('isWithinRecurringWindow — how long a creator keeps earning', () => {
  it('always pays the sale itself (period 1)', () => {
    expect(isWithinRecurringWindow({ recurring: false, recurringMonths: null }, 1)).toBe(true);
    expect(isWithinRecurringWindow({ recurring: true, recurringMonths: 3 }, 1)).toBe(true);
  });

  it('one-time programs never pay renewals', () => {
    expect(isWithinRecurringWindow({ recurring: false, recurringMonths: null }, 2)).toBe(false);
    expect(isWithinRecurringWindow({ recurring: false, recurringMonths: 12 }, 2)).toBe(false);
  });

  it('caps at recurringMonths when set', () => {
    const program = { recurring: true, recurringMonths: 3 };
    expect(isWithinRecurringWindow(program, 2)).toBe(true);
    expect(isWithinRecurringWindow(program, 3)).toBe(true);
    expect(isWithinRecurringWindow(program, 4)).toBe(false);
    expect(isWithinRecurringWindow(program, 12)).toBe(false);
  });

  it('pays for the life of the subscription when no cap is set', () => {
    expect(isWithinRecurringWindow({ recurring: true, recurringMonths: null }, 60)).toBe(true);
    expect(isWithinRecurringWindow({ recurring: true, recurringMonths: 0 }, 60)).toBe(true);
  });
});
