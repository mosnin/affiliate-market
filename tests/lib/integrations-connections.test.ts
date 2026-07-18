/**
 * Tests for `lib/integrations/connections.ts` — the DB-side helpers that
 * back the integrations panel and the chat agent's per-turn toolkit load.
 *
 * The DB hops moved from Supabase to Convex: each helper now calls
 * convex().query / convex().mutation against api.integrations.connections.*.
 * The Convex queries return already-mapped rows (id, not _id) and the
 * `status: 'active'` default for inserts lives in the Convex mutation, not
 * the lib — so we assert on the args the lib forwards and on the values it
 * returns, which are the load-bearing behaviours a refactor could break.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Convex mock — query/mutation steered per test; `api` is a path proxy ───
// so any api.<domain>.<module>.<fn> access stringifies to its dotted path,
// which lets a test branch on String(ref) when call order isn't enough.

const { convexQueryMock, convexMutationMock } = vi.hoisted(() => ({
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
}));
vi.mock('@/lib/convex-server', () => {
  const makePath = (path: string): unknown =>
    new Proxy(() => path, {
      get: (_t, p) => (typeof p === 'string' ? makePath(`${path}.${p}`) : path),
    });
  return {
    api: new Proxy({}, { get: (_t, p) => (typeof p === 'string' ? makePath(p) : undefined) }),
    convex: () => ({ query: convexQueryMock, mutation: convexMutationMock }),
  };
});

// ── Composio mock — only `deleteConnection` matters for this file ──────

const { composioDeleteMock } = vi.hoisted(() => ({
  composioDeleteMock: vi.fn(async () => undefined),
}));
vi.mock('@/lib/integrations/composio', () => ({
  deleteConnection: composioDeleteMock,
  // listConnectedAccountsForEntity is imported by connections.ts (used by
  // reconcileFromComposio, which this file doesn't exercise) — stub it.
  listConnectedAccountsForEntity: vi.fn(),
}));

// ── Triggers mock — revoke now cleans up trigger subscriptions before ─
// flipping the connection. This test file owns the connections contract,
// not the triggers one, so we stub deleteForConnection to a no-op and
// let `tests/lib/integrations-triggers.test.ts` own the trigger-cleanup
// behaviour in isolation. revoke() lazy-imports './triggers', so the mock
// must be on that module path.
const { deleteForConnectionMock } = vi.hoisted(() => ({
  deleteForConnectionMock: vi.fn(async () => undefined),
}));
vi.mock('@/lib/integrations/triggers', () => ({
  deleteForConnection: deleteForConnectionMock,
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  listConnections,
  activeToolkits,
  findActive,
  insertConnection,
  setStatus,
  revoke,
  type IntegrationConnectionRow,
} from '@/lib/integrations/connections';

beforeEach(() => {
  convexQueryMock.mockReset();
  convexMutationMock.mockReset();
  composioDeleteMock.mockReset();
  composioDeleteMock.mockResolvedValue(undefined);
  deleteForConnectionMock.mockReset();
  deleteForConnectionMock.mockResolvedValue(undefined);
});

function fakeRow(over: Partial<IntegrationConnectionRow> = {}): IntegrationConnectionRow {
  return {
    id: 'conn_1',
    spaceId: 'space_1',
    userId: 'user_1',
    toolkit: 'gmail',
    composioConnectionId: 'composio_abc',
    status: 'active',
    label: null,
    lastError: null,
    lastUsedAt: null,
    createdAt: '2026-04-30T12:00:00.000Z',
    updatedAt: '2026-04-30T12:00:00.000Z',
    ...over,
  };
}

// ── listConnections ────────────────────────────────────────────────────

describe('listConnections', () => {
  it('returns rows for the space (Convex listBySpace already orders them)', async () => {
    const rows = [
      fakeRow({ id: 'a', createdAt: '2026-04-30T15:00:00.000Z' }),
      fakeRow({ id: 'b', createdAt: '2026-04-29T15:00:00.000Z' }),
    ];
    convexQueryMock.mockResolvedValue(rows);

    const out = await listConnections('space_1');

    expect(out).toEqual(rows);
    // Verify the query was scoped to this space — a refactor that drops the
    // spaceId arg would leak other spaces' rows. Hard fail.
    expect(convexQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spaceId: 'space_1' }),
    );
  });

  it('returns empty array when the Convex query throws (logs but does not throw)', async () => {
    convexQueryMock.mockRejectedValue(new Error('boom'));
    const out = await listConnections('space_1');
    expect(out).toEqual([]);
  });
});

// ── activeToolkits ─────────────────────────────────────────────────────

describe('activeToolkits', () => {
  it('returns the active toolkit slugs for the (space, user) pair', async () => {
    // The Convex query returns just the slugs (status=active filter lives there).
    convexQueryMock.mockResolvedValue(['gmail', 'slack']);

    const out = await activeToolkits({ spaceId: 'space_1', userId: 'user_1' });

    expect(out).toEqual(['gmail', 'slack']);
    // Both scope args must be forwarded — dropping either is a serious
    // privilege bug (cross-space or cross-user rows leaking).
    expect(convexQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spaceId: 'space_1', userId: 'user_1' }),
    );
  });

  it('returns empty array on error (graceful degradation — chat keeps working)', async () => {
    convexQueryMock.mockRejectedValue(new Error('db down'));
    const out = await activeToolkits({ spaceId: 'space_1', userId: 'user_1' });
    expect(out).toEqual([]);
  });
});

// ── findActive ─────────────────────────────────────────────────────────

describe('findActive', () => {
  it('returns null when no active row matches the triple', async () => {
    convexQueryMock.mockResolvedValue(null);
    const out = await findActive({ spaceId: 'space_1', userId: 'user_1', toolkit: 'gmail' });
    expect(out).toBeNull();
  });

  it('forwards space + user + toolkit and returns the matched row', async () => {
    const row = fakeRow();
    convexQueryMock.mockResolvedValue(row);

    const out = await findActive({ spaceId: 'space_1', userId: 'user_1', toolkit: 'gmail' });

    expect(out).toEqual(row);
    expect(convexQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spaceId: 'space_1', userId: 'user_1', toolkit: 'gmail' }),
    );
  });
});

// ── insertConnection ───────────────────────────────────────────────────

describe('insertConnection', () => {
  it('forwards the connection args and returns the inserted row', async () => {
    // The Convex insert mutation defaults status=active and returns the row.
    const inserted = fakeRow({ id: 'new_id' });
    convexMutationMock.mockResolvedValue(inserted);

    const out = await insertConnection({
      spaceId: 'space_1',
      userId: 'user_1',
      toolkit: 'gmail',
      composioConnectionId: 'composio_xyz',
      label: 'jane@gmail.com',
    });

    expect(out).toEqual(inserted);

    expect(convexMutationMock).toHaveBeenCalledTimes(1);
    const [, mutArgs] = convexMutationMock.mock.calls[0];
    expect(mutArgs).toMatchObject({
      spaceId: 'space_1',
      userId: 'user_1',
      toolkit: 'gmail',
      composioConnectionId: 'composio_xyz',
      label: 'jane@gmail.com',
    });
  });

  it('returns null on error rather than throwing (caller decides UX)', async () => {
    convexMutationMock.mockRejectedValue(new Error('unique violation'));
    const out = await insertConnection({
      spaceId: 'space_1',
      userId: 'user_1',
      toolkit: 'gmail',
      composioConnectionId: 'composio_xyz',
    });
    expect(out).toBeNull();
  });
});

// ── setStatus ──────────────────────────────────────────────────────────

describe('setStatus', () => {
  it('forwards id + status + lastError to the setStatus mutation', async () => {
    convexMutationMock.mockResolvedValue(undefined);

    await setStatus({ id: 'conn_1', status: 'expired', lastError: 'token expired' });

    expect(convexMutationMock).toHaveBeenCalledTimes(1);
    const [, mutArgs] = convexMutationMock.mock.calls[0];
    expect(mutArgs).toMatchObject({
      id: 'conn_1',
      status: 'expired',
      lastError: 'token expired',
    });
  });

  it('omits lastError when none is provided (Convex clears it)', async () => {
    convexMutationMock.mockResolvedValue(undefined);
    await setStatus({ id: 'conn_1', status: 'revoked' });
    const [, mutArgs] = convexMutationMock.mock.calls[0];
    expect(mutArgs).toMatchObject({ id: 'conn_1', status: 'revoked' });
    expect(mutArgs).not.toHaveProperty('lastError');
  });

  it('swallows a mutation error rather than throwing', async () => {
    convexMutationMock.mockRejectedValue(new Error('db down'));
    await expect(setStatus({ id: 'conn_1', status: 'revoked' })).resolves.toBeUndefined();
  });
});

// ── revoke ─────────────────────────────────────────────────────────────

describe('revoke', () => {
  it('deletes triggers, calls Composio delete, then flips the row to revoked', async () => {
    convexMutationMock.mockResolvedValue(undefined);
    const row = fakeRow({ id: 'conn_1', composioConnectionId: 'composio_abc' });

    await revoke(row);

    // Trigger cleanup goes first (owned + asserted by the triggers test file).
    expect(deleteForConnectionMock).toHaveBeenCalledWith('conn_1');
    // Composio side is called with the right vendor id.
    expect(composioDeleteMock).toHaveBeenCalledTimes(1);
    expect(composioDeleteMock).toHaveBeenCalledWith('composio_abc');

    // Then the row is flipped to revoked via the setStatus mutation.
    expect(convexMutationMock).toHaveBeenCalledTimes(1);
    const [, mutArgs] = convexMutationMock.mock.calls[0];
    expect(mutArgs).toMatchObject({ id: 'conn_1', status: 'revoked' });
  });

  it('rejects (and does NOT flip the row) when Composio delete throws', async () => {
    // revoke() awaits composioDelete without try/catch — production gets its
    // safety from composioDelete itself swallowing vendor errors. Document
    // that contract: if composioDelete rejects, revoke rejects, and the row
    // is NOT flipped (pessimistic — caller should retry).
    composioDeleteMock.mockRejectedValueOnce(new Error('vendor 500'));
    convexMutationMock.mockResolvedValue(undefined);
    const row = fakeRow();

    await expect(revoke(row)).rejects.toThrow('vendor 500');
    // The setStatus mutation never ran because the composio call rejected first.
    expect(convexMutationMock).not.toHaveBeenCalled();
  });
});
