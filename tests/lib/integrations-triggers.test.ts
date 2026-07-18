/**
 * Tests for `lib/integrations/triggers.ts` — the lifecycle + dispatch
 * layer for Composio trigger subscriptions.
 *
 * Three behaviours we lock in:
 *   1. registerForConnection registers EACH curated slug and tolerates a
 *      single-slug failure without dropping the rest.
 *   2. dispatchTrigger routes a DRAFT slug to fireRoutineRun with a
 *      templated instruction; an unmapped slug is a no-op; a thin
 *      payload also no-ops.
 *   3. deleteForConnection deletes every Composio trigger AND wipes the
 *      DB rows, in that order.
 *
 * The DB hops moved from Supabase to Convex: registerForConnection's row
 * upsert is api.integrations.triggers.upsertRow (returns boolean — true =
 * registered, false/throw = failed); deleteForConnection lists rows via
 * api.integrations.triggers.listForConnection then deletes them via
 * api.integrations.triggers.deleteForConnection; setPausedForConnection and
 * summariesForConnections call api.integrations.triggers.setPausedForConnection
 * (returns { updated }) and api.integrations.triggers.statusesForConnections
 * (returns [{connectionId,status}], the lib computes the precedence) — so we
 * assert on the lib's RETURN value and steer behaviour with the query/mutation
 * mocks, which is the load-bearing contract a refactor could break.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Composio SDK wrapper mocks ────────────────────────────────────────

const { createTriggerMock, deleteTriggerMock } = vi.hoisted(() => ({
  createTriggerMock: vi.fn(),
  deleteTriggerMock: vi.fn(async () => undefined),
}));

vi.mock('@/lib/integrations/composio', () => ({
  createTrigger: createTriggerMock,
  deleteTrigger: deleteTriggerMock,
}));

// ── fireRoutineRun mock ───────────────────────────────────────────────

const { fireRoutineRunMock } = vi.hoisted(() => ({
  fireRoutineRunMock: vi.fn(async () => 'ok' as const),
}));
vi.mock('@/lib/routines', () => ({
  fireRoutineRun: fireRoutineRunMock,
}));

// ── Convex mock — query/mutation steered per test; `api` is a path proxy
// so any api.<domain>.<module>.<fn> access stringifies to its dotted path,
// letting a test branch on String(ref) when call order isn't enough.

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

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  registerForConnection,
  deleteForConnection,
  dispatchTrigger,
  setPausedForConnection,
  summariesForConnections,
  CURATED_TRIGGERS,
} from '@/lib/integrations/triggers';
import type { IntegrationConnectionRow } from '@/lib/integrations/connections';

function freshConnection(overrides: Partial<IntegrationConnectionRow> = {}): IntegrationConnectionRow {
  return {
    id: 'conn-1',
    spaceId: 'space-1',
    userId: 'user-1',
    toolkit: 'gmail',
    composioConnectionId: 'ca_abc',
    status: 'active',
    label: 'me@example.com',
    lastError: null,
    lastUsedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  createTriggerMock.mockReset();
  deleteTriggerMock.mockReset();
  deleteTriggerMock.mockResolvedValue(undefined);
  fireRoutineRunMock.mockReset();
  fireRoutineRunMock.mockResolvedValue('ok');
  convexQueryMock.mockReset();
  convexMutationMock.mockReset();
});

// ─── CURATED_TRIGGERS sanity ─────────────────────────────────────────────────

describe('CURATED_TRIGGERS', () => {
  it('has an entry for every catalog toolkit that ships triggers', () => {
    // Gmail must ship with at least one slug — the v1 ship gate.
    expect(CURATED_TRIGGERS.gmail).toContain('GMAIL_NEW_GMAIL_MESSAGE');
  });

  it('uses UPPER_SNAKE_CASE for every slug it registers', () => {
    for (const [toolkit, slugs] of Object.entries(CURATED_TRIGGERS)) {
      for (const slug of slugs) {
        expect(slug, `${toolkit} → ${slug}`).toMatch(/^[A-Z][A-Z0-9_]+$/);
      }
    }
  });

  it('every curated slug has a dispatch + a working template', async () => {
    // Catches the failure mode where a slug enters CURATED_TRIGGERS
    // but TRIGGER_DISPATCH / TEMPLATES weren't updated. Registration
    // would succeed at Composio; deliveries would silently no-op.
    // Hits the dispatcher with a generously-shaped payload so the
    // template's bail-out branch doesn't masquerade as "no dispatch".
    const conn = freshConnection();
    const fatPayload = {
      // Cover field names across Gmail/Outlook/Slack/Discord/CRMs/Stripe.
      subject: 'X', from: 'a@b', sender: 'a@b', snippet: 'hi',
      bodyPreview: 'hi', text: 'hi', message: 'hi', user: 'u', author: 'u',
      summary: 'evt', responseStatus: 'accepted', startTime: 'soon',
      attendees: [{ email: 'x@y' }],
      products: { firstname: 'A', lastname: 'B', email: 'a@b', phone: '1', dealname: 'D', dealstage: 'open' },
      name: 'N', company: 'C', leadSource: 'web', stageName: 'open', amount: '1',
      title: 'T', value: '1', personName: 'P',
      amount_total: '1', customer_email: 'a@b', failure_message: 'f', amount_paid: '1',
      taskName: 'T', listName: 'L', reaction: 'thumbs_up',
      cardName: 'C', change: 'moved',
      content: 'msg',
      emailAddress: 'a@b',
    };
    for (const [toolkit, slugs] of Object.entries(CURATED_TRIGGERS)) {
      for (const slug of slugs) {
        const result = await dispatchTrigger({
          triggerSlug: slug,
          connection: conn,
          payload: fatPayload,
        });
        // Every curated slug must either DRAFT or have a well-known
        // skip reason (NOT 'no_dispatch' — that means we forgot to
        // wire it up).
        if (result.dispatched === 'noop') {
          expect(result.reason, `${toolkit} → ${slug} should dispatch on a full payload`).not.toBe('no_dispatch');
        }
      }
    }
  });
});

// ─── registerForConnection ───────────────────────────────────────────────────

describe('registerForConnection', () => {
  it('registers every curated slug and returns the counts', async () => {
    createTriggerMock.mockImplementation(async (args: { slug: string }) => ({
      triggerId: `trg_${args.slug.toLowerCase()}`,
    }));
    // upsertRow resolves true → the row landed → registered++.
    convexMutationMock.mockResolvedValue(true);

    const result = await registerForConnection({ connection: freshConnection() });

    expect(createTriggerMock).toHaveBeenCalledTimes(CURATED_TRIGGERS.gmail.length);
    expect(result.registered).toBe(CURATED_TRIGGERS.gmail.length);
    expect(result.failed).toBe(0);
  });

  it('records a failed row when one slug throws and continues the rest', async () => {
    // Force a failure by faking gmail to have two slugs for this test —
    // we mock createTrigger by call index, regardless of the map's real
    // length (the asserts below don't depend on map size).
    const slugCount = CURATED_TRIGGERS.gmail.length;
    if (slugCount < 1) {
      throw new Error('gmail map must have at least one slug for this test to be meaningful');
    }
    createTriggerMock.mockImplementationOnce(async () => {
      throw new Error('composio said no');
    });
    // Subsequent calls succeed.
    createTriggerMock.mockImplementation(async (args: { slug: string }) => ({
      triggerId: `trg_${args.slug.toLowerCase()}`,
    }));
    // upsertRow always lands (both the failed-row record in the catch and the
    // success-path rows). The failed count comes from createTrigger throwing,
    // not from the mutation.
    convexMutationMock.mockResolvedValue(true);

    const result = await registerForConnection({ connection: freshConnection() });

    expect(result.failed).toBe(1);
    expect(result.registered).toBe(slugCount - 1);
  });

  it('is a no-op when the toolkit has no curated triggers', async () => {
    // `zoho` is intentionally empty in CURATED_TRIGGERS (see the per-
    // entry comment in lib/integrations/triggers.ts). If this test
    // starts failing, either (a) zoho got triggers, in which case
    // swap to another intentionally-empty toolkit, or (b) we
    // accidentally registered something — investigate the map.
    const result = await registerForConnection({
      connection: freshConnection({ toolkit: 'zoho' }),
    });
    expect(createTriggerMock).not.toHaveBeenCalled();
    expect(result).toEqual({ registered: 0, failed: 0 });
  });
});

// ─── deleteForConnection ─────────────────────────────────────────────────────

describe('deleteForConnection', () => {
  it('deletes every Composio trigger AND the DB rows', async () => {
    // listForConnection (query) returns the rows; deleteForConnection (mutation)
    // wipes them DB-side.
    convexQueryMock.mockResolvedValue([
      { id: 'r1', composioTriggerId: 'trg_a', connectionId: 'conn-1' },
      { id: 'r2', composioTriggerId: 'trg_b', connectionId: 'conn-1' },
    ]);
    convexMutationMock.mockResolvedValue(undefined);

    await deleteForConnection('conn-1');

    // Composio-side delete fires per row, with the right vendor ids.
    expect(deleteTriggerMock).toHaveBeenCalledWith('trg_a');
    expect(deleteTriggerMock).toHaveBeenCalledWith('trg_b');
    expect(deleteTriggerMock).toHaveBeenCalledTimes(2);
    // Then the DB-side wipe runs, scoped to this connection.
    expect(convexMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ connectionId: 'conn-1' }),
    );
  });

  it('skips Composio delete for rows with null composioTriggerId', async () => {
    convexQueryMock.mockResolvedValue([
      { id: 'r1', composioTriggerId: null, connectionId: 'conn-1' },
    ]);
    convexMutationMock.mockResolvedValue(undefined);

    await deleteForConnection('conn-1');

    expect(deleteTriggerMock).not.toHaveBeenCalled();
    // The DB-side wipe still runs even when there's no Composio side to clean.
    expect(convexMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ connectionId: 'conn-1' }),
    );
  });
});

// ─── setPausedForConnection ──────────────────────────────────────────────────

describe('setPausedForConnection', () => {
  it('forwards paused:true + the connectionId and returns the updated count', async () => {
    // The active→paused filter + flip now lives in the Convex mutation, which
    // returns { updated }. The lib's job is to forward the args and surface the
    // count — assert that contract, not the (moved) SQL filter.
    convexMutationMock.mockResolvedValue({ updated: 2 });

    const result = await setPausedForConnection({ connectionId: 'conn-1', paused: true });

    expect(result.updated).toBe(2);
    expect(convexMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ connectionId: 'conn-1', paused: true }),
    );
  });

  it('forwards paused:false + the connectionId and returns the updated count', async () => {
    convexMutationMock.mockResolvedValue({ updated: 1 });

    const result = await setPausedForConnection({ connectionId: 'conn-1', paused: false });

    expect(result.updated).toBe(1);
    expect(convexMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ connectionId: 'conn-1', paused: false }),
    );
  });

  it('returns updated:0 (does not throw) when the mutation fails', async () => {
    // The lib swallows a Convex error and degrades to a zero-count result so a
    // panel toggle never 500s the request.
    convexMutationMock.mockRejectedValue(new Error('db down'));
    const result = await setPausedForConnection({ connectionId: 'conn-1', paused: true });
    expect(result).toEqual({ updated: 0 });
  });
});

// ─── summariesForConnections ─────────────────────────────────────────────────

describe('summariesForConnections', () => {
  // statusesForConnections (query) returns the raw (connectionId, status) pairs;
  // the lib computes the off<failed<paused<active precedence — that's the
  // behaviour these tests lock in, steered via the query mock's return value.
  it('returns "active" when ANY trigger row is active', async () => {
    convexQueryMock.mockResolvedValue([
      { connectionId: 'c1', status: 'paused' },
      { connectionId: 'c1', status: 'active' }, // wins
    ]);

    const result = await summariesForConnections(['c1']);
    expect(result.c1).toBe('active');
  });

  it('returns "paused" only when all rows are paused', async () => {
    convexQueryMock.mockResolvedValue([
      { connectionId: 'c1', status: 'paused' },
      { connectionId: 'c1', status: 'paused' },
    ]);

    const result = await summariesForConnections(['c1']);
    expect(result.c1).toBe('paused');
  });

  it('returns "off" for connections with no rows', async () => {
    convexQueryMock.mockResolvedValue([]);

    const result = await summariesForConnections(['c1', 'c2']);
    expect(result.c1).toBe('off');
    expect(result.c2).toBe('off');
  });

  it('is a no-op for an empty input list', async () => {
    const result = await summariesForConnections([]);
    expect(result).toEqual({});
    // Short-circuits before any DB hop.
    expect(convexQueryMock).not.toHaveBeenCalled();
  });
});

// ─── dispatchTrigger ─────────────────────────────────────────────────────────

describe('dispatchTrigger', () => {
  it('routes a DRAFT slug to fireRoutineRun with a templated instruction', async () => {
    const result = await dispatchTrigger({
      triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
      connection: freshConnection(),
      payload: {
        subject: 'Offer accepted on 1421 Maple',
        from: 'sarah@example.com',
        snippet: 'Hi — we accept. When can we sign?',
      },
    });

    expect(result.dispatched).toBe('DRAFT');
    expect(fireRoutineRunMock).toHaveBeenCalledTimes(1);
    const call = fireRoutineRunMock.mock.calls[0] as unknown as [string, string, string];
    const [spaceId, instruction, userId] = call;
    expect(spaceId).toBe('space-1');
    expect(userId).toBe('user-1');
    expect(instruction).toContain('Offer accepted on 1421 Maple');
    expect(instruction).toContain('sarah@example.com');
    expect(instruction).toContain('we accept');
    // The honest cue: instruction must tell the model NOT to act on noise.
    expect(instruction.toLowerCase()).toContain('noise');
  });

  it('skips fireRoutineRun when the payload is too thin to act on', async () => {
    const result = await dispatchTrigger({
      triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
      connection: freshConnection(),
      payload: {},
    });
    expect(result.dispatched).toBe('noop');
    expect(result.reason).toBe('thin_payload');
    expect(fireRoutineRunMock).not.toHaveBeenCalled();
  });

  it('no-ops for a slug with no dispatch handler', async () => {
    const result = await dispatchTrigger({
      triggerSlug: 'NOT_A_REAL_TRIGGER',
      connection: freshConnection(),
      payload: { anything: 'ok' },
    });
    expect(result.dispatched).toBe('noop');
    expect(result.reason).toBe('no_dispatch');
    expect(fireRoutineRunMock).not.toHaveBeenCalled();
  });
});
