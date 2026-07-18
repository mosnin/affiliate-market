import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Reversal + clawback math, isolated from the database. We mock supabase so
 * these tests assert the BEHAVIOUR — what gets reversed, what the partner
 * balance becomes — without standing up Postgres. The DB wiring itself is
 * covered by the live audit.
 */

type Row = Record<string, unknown>;

// In-memory tables the mock reads/writes.
const db: { commissions: Row[]; partners: Row[] } = { commissions: [], partners: [] };

vi.mock('@/lib/supabase', () => {
  function makeQuery(table: string) {
    let rows: Row[] = table === 'AffiliateCommission' ? db.commissions : db.partners;
    let updateValues: Row | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    const api: Record<string, unknown> = {
      select() { return api; },
      update(v: Row) { updateValues = v; return api; },
      eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return api; },
      neq(col: string, val: unknown) { filters.push((r) => r[col] !== val); return api; },
      maybeSingle() {
        const match = rows.filter((r) => filters.every((f) => f(r)))[0] ?? null;
        return Promise.resolve({ data: match, error: null });
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (updateValues) for (const r of matched) Object.assign(r, updateValues);
        return Promise.resolve(resolve({ data: matched, error: null }));
      },
    };
    return api;
  }
  return { supabase: { from: (t: string) => makeQuery(t) } };
});

import {
  reverseCommissionsForOrder,
  reverseCommissionsForInvoice,
} from '@/lib/affiliates/reversals';

beforeEach(() => {
  db.commissions = [];
  db.partners = [];
});

describe('commission reversals', () => {
  it('reverses a pending commission without touching partner balance', async () => {
    db.partners = [{ id: 'p1', balanceAdjustmentCents: 0 }];
    db.commissions = [
      { id: 'c1', orderId: 'o1', partnerId: 'p1', status: 'pending', netCents: 784, amountCents: 980, source: 'marketplace', settledAt: null },
    ];
    const res = await reverseCommissionsForOrder('o1', 'Charge refunded');
    expect(res.reversed).toBe(1);
    expect(res.clawedBackCents).toBe(0);
    expect(db.commissions[0].status).toBe('reversed');
    expect(db.partners[0].balanceAdjustmentCents).toBe(0);
  });

  it('claws back a PAID commission into a negative partner balance', async () => {
    db.partners = [{ id: 'p1', balanceAdjustmentCents: 0 }];
    db.commissions = [
      { id: 'c1', orderId: 'o1', partnerId: 'p1', status: 'paid', netCents: 784, amountCents: 980, source: 'marketplace', settledAt: null },
    ];
    const res = await reverseCommissionsForOrder('o1', 'Charge refunded');
    expect(res.reversed).toBe(1);
    expect(res.clawedBackCents).toBe(784);
    expect(db.commissions[0].status).toBe('reversed');
    expect(db.partners[0].balanceAdjustmentCents).toBe(-784);
  });

  it('is idempotent — a second reversal does nothing', async () => {
    db.partners = [{ id: 'p1', balanceAdjustmentCents: -784 }];
    db.commissions = [
      { id: 'c1', orderId: 'o1', partnerId: 'p1', status: 'reversed', netCents: 784, amountCents: 980, source: 'marketplace', settledAt: null },
    ];
    const res = await reverseCommissionsForOrder('o1', 'Charge refunded again');
    expect(res.reversed).toBe(0);
    expect(db.partners[0].balanceAdjustmentCents).toBe(-784);
  });

  it('notes settled bridge commissions for manual reconciliation', async () => {
    db.partners = [{ id: 'p1', balanceAdjustmentCents: 0 }];
    db.commissions = [
      { id: 'c1', stripeInvoiceId: 'in_1', partnerId: 'p1', status: 'paid', netCents: 784, amountCents: 980, source: 'stripe_bridge', settledAt: '2026-06-01T00:00:00Z' },
    ];
    await reverseCommissionsForInvoice('in_1', 'Charge disputed');
    expect(db.commissions[0].status).toBe('reversed');
    expect(String(db.commissions[0].reversalReason)).toContain('reconcile manually');
  });
});
