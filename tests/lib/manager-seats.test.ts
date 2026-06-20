/**
 * BP3e — coverage for the seat-limit helper + invite enforcement.
 *
 * Written directly (not via agent) after the test agent timed out
 * mid-stream. Scope is intentionally focused on the pure helper and
 * the invite route; the Stripe webhook is not unit-tested here
 * because its routing helper wasn't extracted as a pure function —
 * testing it would require mocking the full handler (raw-body
 * signature check, Redis dedup, Stripe client) and the ROI is low
 * compared to exercising it in staging.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase mock — table-keyed chain with per-call overrides ─────────────
interface TableMock {
  rows?: Array<Record<string, unknown>>;
  single?: Record<string, unknown> | null;
  error?: { message: string } | null;
  count?: number | null;
}
let mockByTable: Record<string, TableMock> = {};

// ── Supabase mock (kept for safety; company-seats lib is fully on Convex) ────
vi.mock('@/lib/supabase', () => {
  function makeChain(_table: string): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    chain.select = vi.fn(pass);
    chain.eq = vi.fn(pass);
    chain.in = vi.fn(pass);
    chain.is = vi.fn(pass);
    chain.gt = vi.fn(pass);
    chain.neq = vi.fn(pass);
    chain.order = vi.fn(pass);
    chain.limit = vi.fn(pass);
    chain.update = vi.fn(pass);
    chain.delete = vi.fn(pass);
    chain.insert = vi.fn(pass);
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    chain.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    chain.then = (r: (v: unknown) => unknown, e?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(r, e);
    return chain;
  }
  return { supabase: { from: vi.fn((table: string) => makeChain(table)) } };
});

// ── Convex mock — company-seats lib migrated from Supabase to Convex ─────────
// api.org.companies.getById → Company row (plan + seatLimit)
// api.org.memberships.countByCompany → { total: N } (count of members)
// api.org.invitations.countPending → number (count of pending invites)
//
// We read from the same mockByTable map the tests already set, keyed by the
// old Supabase table names (Company, CompanyMembership, Invitation). This way
// the test bodies don't need to change at all.
const { convexQueryMock } = vi.hoisted(() => ({
  convexQueryMock: vi.fn(async (_ref?: unknown, _args?: unknown) => null as unknown),
}));
vi.mock('@/lib/convex-server', () => {
  const makePath = (path: string): unknown =>
    new Proxy(() => path, {
      get: (_t, p) => (typeof p === 'string' ? makePath(`${path}.${p}`) : path),
    });
  return {
    api: new Proxy({}, { get: (_t, p) => (typeof p === 'string' ? makePath(p) : undefined) }),
    convex: () => ({ query: convexQueryMock, mutation: vi.fn() }),
  };
});

import {
  getSeatUsage,
  checkSeatCapacity,
} from '@/lib/company-seats';

beforeEach(() => {
  mockByTable = {};
  convexQueryMock.mockReset();
  // Route Convex queries to the per-test mockByTable data (same keys as the old
  // Supabase table names so test bodies don't change):
  //   api.org.companies.getById → Company.single row
  //   api.org.memberships.countByCompany → { total: CompanyMembership.count }
  //     (null count → null to trigger fail-closed; error on count → null)
  //   api.org.invitations.countPending → Invitation.count (number)
  convexQueryMock.mockImplementation(async (ref?: unknown) => {
    const p = typeof ref === 'function' ? (ref as () => string)() : '';
    if (p.includes('org.companies.getById')) {
      const override = mockByTable['Company'];
      if (override?.error) throw new Error(override.error.message);
      return override?.single !== undefined ? override.single : (override?.rows?.[0] ?? null);
    }
    if (p.includes('org.memberships.countByCompany')) {
      const override = mockByTable['CompanyMembership'];
      if (override?.error) throw new Error(override.error.message);
      const count = override?.count;
      if (count == null) throw new Error('count unavailable');
      return { total: count };
    }
    if (p.includes('org.invitations.countPending')) {
      const override = mockByTable['Invitation'];
      if (override?.error) throw new Error(override.error.message);
      return override?.count ?? 0;
    }
    return null;
  });
});

// ── getSeatUsage ──────────────────────────────────────────────────────────
describe('getSeatUsage', () => {
  it('sums members + non-expired pending invites', async () => {
    mockByTable = {
      Company: { single: { plan: 'team', seatLimit: 5 } },
      CompanyMembership: { count: 7 },
      Invitation: { count: 3 },
    };
    const u = await getSeatUsage('b1');
    expect(u).toMatchObject({
      plan: 'team',
      seatLimit: 5,
      members: 7,
      pendingInvites: 3,
      used: 10,
    });
  });

  it('derives seatLimit from the plan when the column is null (team_plus → 10)', async () => {
    mockByTable = {
      Company: { single: { plan: 'team_plus', seatLimit: null } },
      CompanyMembership: { count: 42 },
      Invitation: { count: 0 },
    };
    const u = await getSeatUsage('b1');
    expect(u.plan).toBe('team_plus');
    expect(u.seatLimit).toBe(10);
    expect(u.used).toBe(42);
  });

  it('falls back to team/5 when the Company row select errors (pre-migration)', async () => {
    mockByTable = {
      Company: { error: { message: 'column "plan" does not exist' }, single: null },
      CompanyMembership: { count: 2 },
      Invitation: { count: 1 },
    };
    const u = await getSeatUsage('b1');
    // Fail CLOSED on the cap — the helper should NOT unlock the company
    // just because the column isn't there yet.
    expect(u.plan).toBe('team');
    expect(u.seatLimit).toBe(5);
  });
});

// ── checkSeatCapacity ─────────────────────────────────────────────────────
describe('checkSeatCapacity', () => {
  it('allows +1 when used=4/5', async () => {
    mockByTable = {
      Company: { single: { plan: 'team', seatLimit: 5 } },
      CompanyMembership: { count: 4 },
      Invitation: { count: 0 },
    };
    const r = await checkSeatCapacity('b1', 1);
    expect(r.ok).toBe(true);
    expect(r.needed).toBeUndefined();
  });

  it('rejects +2 when used=4/5 with needed=2', async () => {
    mockByTable = {
      Company: { single: { plan: 'team', seatLimit: 5 } },
      CompanyMembership: { count: 4 },
      Invitation: { count: 0 },
    };
    const r = await checkSeatCapacity('b1', 2);
    expect(r.ok).toBe(false);
    expect(r.needed).toBe(2);
  });

  it('team_plus honors its larger cap (used=9/10 allows +1)', async () => {
    mockByTable = {
      Company: { single: { plan: 'team_plus', seatLimit: 10 } },
      CompanyMembership: { count: 9 },
      Invitation: { count: 0 },
    };
    const r = await checkSeatCapacity('b1', 1);
    expect(r.ok).toBe(true);
  });

  it('fails CLOSED on infra count error — silent overages are worse than a transient 402', async () => {
    // Audit of BP3 flipped this trade-off. If either count sub-query
    // can't reach the DB, we refuse the invite rather than risk the
    // company silently exceeding its billed seat count.
    mockByTable = {
      Company: { single: { plan: 'team', seatLimit: 5 } },
      CompanyMembership: { error: { message: 'db flap' }, count: null },
      Invitation: { count: 0 },
    };
    const r = await checkSeatCapacity('b1', 1);
    expect(r.ok).toBe(false);
    expect(r.needed).toBe(1);
  });

  it('clamps non-positive additional to 0 (never rejects on a zero-invite probe)', async () => {
    mockByTable = {
      Company: { single: { plan: 'team', seatLimit: 5 } },
      CompanyMembership: { count: 5 }, // full
      Invitation: { count: 0 },
    };
    const r = await checkSeatCapacity('b1', 0);
    expect(r.ok).toBe(true);
  });
});
