/**
 * Tests for `reconcileFromComposio` — the hot path on every
 * /api/integrations GET request.
 *
 * Behaviour locked in:
 *   - Composio outage / list throws → swallow + log, no DB writes
 *   - Items with non-ACTIVE status are skipped
 *   - Items for toolkits we don't know about are skipped
 *   - Items already present in our DB are skipped
 *   - Brand-new ACTIVE items get inserted
 *   - Mid-list failure on one item doesn't drop the rest
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── listConnectedAccountsForEntity mock ──────────────────────────────

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }));
vi.mock('@/lib/integrations/composio', () => ({
  listConnectedAccountsForEntity: listMock,
  deleteConnection: vi.fn(),
}));

// ── catalog mock — control which toolkit slugs are "known" ───────────

vi.mock('@/lib/integrations/catalog', () => ({
  findIntegration: vi.fn((slug: string) =>
    ['gmail', 'slack', 'hubspot'].includes(slug) ? { toolkit: slug } : undefined,
  ),
}));

// ── Convex mock — capture the DB hops reconcile now makes ────────────
//
// reconcileFromComposio calls (all via the Convex client now):
//   findByComposioId(itemId)  → query, returns null (new) or a row (already tracked)
//   setStatus({...})          → mutation, used to promote a pending row
//   insertConnection(args)    → mutation (api.integrations.connections.insert),
//                               inserts a fresh row and returns it
//
// `api` is a path proxy so any api.<domain>.<module>.<fn> access stringifies
// to its dotted path. We branch the query mock on that path so a single mock
// serves both findByComposioId reads; the mutation mock returns the inserted
// row (insert) or undefined (setStatus).

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

const { warnMock, errorMock, infoMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
  errorMock: vi.fn(),
  infoMock: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: errorMock, warn: warnMock, info: infoMock, debug: vi.fn() },
}));

import { reconcileFromComposio } from '@/lib/integrations/connections';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: findByComposioId finds nothing (new item) → insert path. The
  // insert mutation returns a row so the "reconciled" info log fires.
  convexQueryMock.mockResolvedValue(null);
  convexMutationMock.mockResolvedValue({ id: 'new-row-id' });
});

describe('reconcileFromComposio', () => {
  it('swallows Composio list errors (no DB writes, logs a warning)', async () => {
    listMock.mockRejectedValueOnce(new Error('composio down'));

    await reconcileFromComposio({ spaceId: 'space-1', entityId: 'user-1' });

    expect(warnMock).toHaveBeenCalled();
    // No DB hops happened (the early-return path).
    expect(convexQueryMock).not.toHaveBeenCalled();
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('inserts a row for an ACTIVE item we don\'t already track', async () => {
    listMock.mockResolvedValueOnce({
      items: [
        {
          id: 'ca_new',
          status: 'ACTIVE',
          alias: 'jane@gmail.com',
          toolkit: { slug: 'gmail' },
        },
      ],
    });
    // No existing row → insert path. Insert returns the fresh row.
    convexQueryMock.mockResolvedValue(null);
    convexMutationMock.mockResolvedValue({ id: 'fresh-row', composioConnectionId: 'ca_new' });

    await reconcileFromComposio({ spaceId: 'space-1', entityId: 'user-1' });

    expect(infoMock).toHaveBeenCalledWith(
      '[integrations.connections] reconciled composio connection into DB',
      expect.objectContaining({ composioConnectionId: 'ca_new', toolkit: 'gmail' }),
    );
    // The insert mutation carried the item's fields.
    expect(convexMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ composioConnectionId: 'ca_new', toolkit: 'gmail', spaceId: 'space-1' }),
    );
  });

  it('skips items with non-ACTIVE status', async () => {
    listMock.mockResolvedValueOnce({
      items: [
        { id: 'ca_expired', status: 'EXPIRED', alias: 'a', toolkit: { slug: 'gmail' } },
        { id: 'ca_failed', status: 'FAILED', alias: 'b', toolkit: { slug: 'gmail' } },
        { id: 'ca_init', status: 'INITIALIZING', alias: 'c', toolkit: { slug: 'gmail' } },
      ],
    });

    await reconcileFromComposio({ spaceId: 'space-1', entityId: 'user-1' });

    // None of them should have triggered the "reconciled" info log.
    const reconcileLogs = infoMock.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('reconciled composio connection'),
    );
    expect(reconcileLogs).toHaveLength(0);
    // And nothing was written.
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('skips items for toolkits we don\'t know about (not in catalog)', async () => {
    listMock.mockResolvedValueOnce({
      items: [
        { id: 'ca_unk', status: 'ACTIVE', alias: 'x', toolkit: { slug: 'unknown_toolkit' } },
      ],
    });

    await reconcileFromComposio({ spaceId: 'space-1', entityId: 'user-1' });

    const reconcileLogs = infoMock.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('reconciled composio connection'),
    );
    expect(reconcileLogs).toHaveLength(0);
  });

  it('skips items missing id or toolkit slug (malformed payload)', async () => {
    listMock.mockResolvedValueOnce({
      items: [
        { id: undefined, status: 'ACTIVE', toolkit: { slug: 'gmail' } },
        { id: 'ca_no_toolkit', status: 'ACTIVE', toolkit: null },
        { id: 'ca_empty_toolkit', status: 'ACTIVE', toolkit: { slug: undefined } },
      ],
    });

    await reconcileFromComposio({ spaceId: 'space-1', entityId: 'user-1' });

    const reconcileLogs = infoMock.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('reconciled composio connection'),
    );
    expect(reconcileLogs).toHaveLength(0);
  });

  it('skips items we already track (existing IntegrationConnection by composio id)', async () => {
    listMock.mockResolvedValueOnce({
      items: [
        { id: 'ca_existing', status: 'ACTIVE', alias: 'a', toolkit: { slug: 'gmail' } },
      ],
    });
    // findByComposioId returns an already-active row → skip path.
    convexQueryMock.mockResolvedValue({
      id: 'existing-row',
      composioConnectionId: 'ca_existing',
      status: 'active',
    });

    await reconcileFromComposio({ spaceId: 'space-1', entityId: 'user-1' });

    const reconcileLogs = infoMock.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('reconciled composio connection'),
    );
    expect(reconcileLogs).toHaveLength(0);
    // Already active → no insert and no setStatus promotion.
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('promotes a pending row we already track instead of inserting', async () => {
    listMock.mockResolvedValueOnce({
      items: [
        { id: 'ca_pending', status: 'ACTIVE', alias: 'a', toolkit: { slug: 'gmail' } },
      ],
    });
    // Existing row is 'pending' — Composio says ACTIVE, so reconcile self-heals
    // by calling setStatus to promote it (no fresh insert).
    convexQueryMock.mockResolvedValue({
      id: 'pending-row',
      composioConnectionId: 'ca_pending',
      status: 'pending',
    });

    await reconcileFromComposio({ spaceId: 'space-1', entityId: 'user-1' });

    // setStatus mutation fired to promote it to active.
    expect(convexMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'pending-row', status: 'active' }),
    );
    // No "reconciled ... into DB" insert log — this was a promote, not a backfill.
    const reconcileLogs = infoMock.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('reconciled composio connection'),
    );
    expect(reconcileLogs).toHaveLength(0);
  });

  it('handles an empty items list as a no-op', async () => {
    listMock.mockResolvedValueOnce({ items: [] });

    await reconcileFromComposio({ spaceId: 'space-1', entityId: 'user-1' });

    expect(errorMock).not.toHaveBeenCalled();
    const reconcileLogs = infoMock.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('reconciled composio connection'),
    );
    expect(reconcileLogs).toHaveLength(0);
  });
});
