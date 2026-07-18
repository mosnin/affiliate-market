/**
 * Unit tests for lib/agent/kill-switch.ts
 *
 * Tests cover:
 *  - isSpaceDisabled() — space not disabled (null row) → false
 *  - isSpaceDisabled() — space disabled (row present) → true
 *  - Cache hit — DB called only once for repeated same-spaceId queries
 *  - Cache expiry — past-TTL second call re-queries DB
 *  - assertSpaceEnabled() — resolves without throwing when space is enabled
 *  - assertSpaceEnabled() — throws Error("space_disabled:<id>") when space is disabled
 *  - DB error — isSpaceDisabled() throws (the module propagates the error)
 *
 * Mock strategy:
 *  - vi.mock('@/lib/supabase') using a per-test configurable responder so each
 *    test fully controls what the chainable Supabase client returns.
 *  - vi.spyOn(Date, 'now') for cache-expiry tests.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ── Convex mock ───────────────────────────────────────────────────────────────
//
// kill-switch.ts was migrated from Supabase to Convex: isSpaceDisabled now calls
// `convex().query(api.workspace.disabled.isDisabled, { spaceId })`, which returns
// a boolean directly (the old `.maybeSingle()` returned a row/null and the lib
// derived the boolean; now the boolean is the function's return value). We mock
// `@/lib/convex-server` and drive the query mock with a per-test "responder" so
// each test fully controls what the DB returns (true / false / throw).
//
// The call counter increments on every isDisabled query — that's the DB hit the
// cache tests assert on (one per uncached lookup). Tracked on globalThis so the
// hoisted factory and the test body share the same counter across module loads.

const { getResponder, setResponder } = vi.hoisted(() => {
  // Default: space not disabled → isDisabled returns false.
  let responder: () => Promise<boolean> = async () => false;
  return {
    getResponder: () => responder,
    setResponder: (fn: typeof responder) => {
      responder = fn;
    },
  };
});

const { convexQueryMock } = vi.hoisted(() => ({
  convexQueryMock: vi.fn(async (_ref?: unknown, _args?: unknown) => {
    const current =
      ((globalThis as Record<string, unknown>).__killSwitchCallCount__ as number) ?? 0;
    (globalThis as Record<string, unknown>).__killSwitchCallCount__ = current + 1;
    return getResponder()();
  }),
}));

vi.mock('@/lib/convex-server', () => {
  const makePath = (path: string): unknown =>
    new Proxy(() => path, {
      get: (_t, p) => (typeof p === 'string' ? makePath(`${path}.${p}`) : path),
    });
  return {
    api: new Proxy({}, { get: (_t, p) => (typeof p === 'string' ? makePath(p) : undefined) }),
    convex: () => ({ query: convexQueryMock, mutation: vi.fn(), action: vi.fn() }),
  };
});

// Import AFTER mocks so kill-switch picks up the mocked convex client.
import { isSpaceDisabled, assertSpaceEnabled } from '../kill-switch';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns how many times the DB's maybeSingle was invoked since last reset. */
function dbCallCount(): number {
  return ((globalThis as Record<string, unknown>).__killSwitchCallCount__ as number) ?? 0;
}

function resetDbCallCount() {
  (globalThis as Record<string, unknown>).__killSwitchCallCount__ = 0;
}

// ── Setup ─────────────────────────────────────────────────────────────────────
//
// The kill-switch module maintains a module-level cache Map. We can't reset it
// between tests via imports, but we CAN use unique spaceIds per test to avoid
// cross-test cache contamination. Each test uses a unique spaceId string.

let testId = 0;
function uniqueSpaceId(): string {
  return `space_test_${++testId}_${Math.random().toString(36).slice(2)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbCallCount();
  // Default: space is not disabled
  setResponder(async () => false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── isSpaceDisabled ───────────────────────────────────────────────────────────

describe('isSpaceDisabled()', () => {
  it('returns false when the DB reports the space is not disabled', async () => {
    setResponder(async () => false);
    const spaceId = uniqueSpaceId();
    const result = await isSpaceDisabled(spaceId);
    expect(result).toBe(false);
  });

  it('returns true when the DB reports the space is disabled', async () => {
    setResponder(async () => true);
    const spaceId = uniqueSpaceId();
    const result = await isSpaceDisabled(spaceId);
    expect(result).toBe(true);
  });

  it('queries the DB on first call for a spaceId', async () => {
    setResponder(async () => false);
    const spaceId = uniqueSpaceId();
    resetDbCallCount();
    await isSpaceDisabled(spaceId);
    expect(dbCallCount()).toBe(1);
  });

  describe('cache hit', () => {
    it('serves the second call from cache — DB queried only once', async () => {
      setResponder(async () => false);
      const spaceId = uniqueSpaceId();
      resetDbCallCount();

      await isSpaceDisabled(spaceId);
      await isSpaceDisabled(spaceId); // should hit cache

      expect(dbCallCount()).toBe(1);
    });

    it('cached value matches the original DB result', async () => {
      setResponder(async () => true);
      const spaceId = uniqueSpaceId();

      const first = await isSpaceDisabled(spaceId);
      // Change the mock to return false — cache should still serve true
      setResponder(async () => false);
      const second = await isSpaceDisabled(spaceId);

      expect(first).toBe(true);
      expect(second).toBe(true); // still from cache
    });
  });

  describe('cache expiry', () => {
    it('re-queries the DB when the 30s TTL has elapsed', async () => {
      const spaceId = uniqueSpaceId();
      const realNow = Date.now();

      // First call at t=0
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow);
      setResponder(async () => false);
      await isSpaceDisabled(spaceId);

      // Advance clock past 30s TTL
      dateSpy.mockReturnValue(realNow + 31_000);
      resetDbCallCount();

      // Second call should bypass expired cache and hit DB again
      await isSpaceDisabled(spaceId);
      expect(dbCallCount()).toBe(1);
    });

    it('does NOT re-query when clock advance is under 30s', async () => {
      const spaceId = uniqueSpaceId();
      const realNow = Date.now();

      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow);
      setResponder(async () => false);
      await isSpaceDisabled(spaceId);

      // Advance only 15s — cache still valid
      dateSpy.mockReturnValue(realNow + 15_000);
      resetDbCallCount();

      await isSpaceDisabled(spaceId);
      expect(dbCallCount()).toBe(0); // served from cache
    });
  });

  describe('DB error', () => {
    it('throws when the Convex query fails (kill-switch propagates DB errors)', async () => {
      // The migrated lib no longer wraps the error in its own message — it lets
      // the Convex query throw propagate to the caller (see kill-switch.ts:
      // "Convex throws on failure ... let it propagate"). Intent preserved: a
      // failed lookup throws rather than silently returning false.
      setResponder(async () => {
        throw new Error('connection refused');
      });
      const spaceId = uniqueSpaceId();
      await expect(isSpaceDisabled(spaceId)).rejects.toThrow('connection refused');
    });
  });
});

// ── assertSpaceEnabled ────────────────────────────────────────────────────────

describe('assertSpaceEnabled()', () => {
  it('resolves without throwing when the space is enabled (not disabled)', async () => {
    setResponder(async () => false);
    const spaceId = uniqueSpaceId();
    await expect(assertSpaceEnabled(spaceId)).resolves.toBeUndefined();
  });

  it('throws an Error with message starting "space_disabled:" when the space is disabled', async () => {
    setResponder(async () => true);
    const spaceId = uniqueSpaceId();
    await expect(assertSpaceEnabled(spaceId)).rejects.toThrow(
      `space_disabled:${spaceId}`,
    );
  });

  it('thrown error message starts with "space_disabled:"', async () => {
    setResponder(async () => true);
    const spaceId = uniqueSpaceId();
    let thrown: Error | null = null;
    try {
      await assertSpaceEnabled(spaceId);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toMatch(/^space_disabled:/);
  });

  it('thrown error contains the spaceId', async () => {
    setResponder(async () => true);
    const spaceId = 'space_important_tenant_xyz';
    let thrown: Error | null = null;
    try {
      await assertSpaceEnabled(spaceId);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain(spaceId);
  });
});
