import { describe, expect, it } from 'vitest';
import { resolveCommissionPlan, calculateCommissionCents } from '@/lib/affiliates/commissions';

const program = { commissionType: 'percent' as const, commissionValue: 20 };

describe('resolveCommissionPlan — per-product override', () => {
  it('uses the program default when the product has no override', () => {
    expect(resolveCommissionPlan(program, null)).toEqual(program);
    expect(resolveCommissionPlan(program, { commissionType: null, commissionValue: null })).toEqual(program);
  });

  it('uses the product override when both fields are set', () => {
    expect(resolveCommissionPlan(program, { commissionType: 'percent', commissionValue: 40 })).toEqual({
      commissionType: 'percent',
      commissionValue: 40,
    });
    expect(resolveCommissionPlan(program, { commissionType: 'flat', commissionValue: 500 })).toEqual({
      commissionType: 'flat',
      commissionValue: 500,
    });
  });

  it('ignores a partial or zero override (falls back to program)', () => {
    expect(resolveCommissionPlan(program, { commissionType: 'percent', commissionValue: 0 })).toEqual(program);
    expect(resolveCommissionPlan(program, { commissionType: null, commissionValue: 40 })).toEqual(program);
  });

  it('feeds the right rate into the commission math', () => {
    const plan = resolveCommissionPlan(program, { commissionType: 'percent', commissionValue: 40 });
    expect(calculateCommissionCents(plan, 10000)).toBe(4000); // 40% override, not 20%
  });
});
