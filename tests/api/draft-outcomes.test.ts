/**
 * Route-level integration test for `GET /api/cron/draft-outcomes`.
 *
 * The cron scans recently-sent AgentDraft rows, looks up linked Deals,
 * and labels each draft 'deal_advanced' or 'none' on `outcome_signal`.
 * Tests cover:
 *   - Auth (Bearer CRON_SECRET)
 *   - Kill switch (CRON_OUTCOMES_DISABLED)
 *   - Empty result
 *   - Happy path: deal advanced after the draft sent → 'deal_advanced'
 *   - No-deal-link case → 'none'
 *   - Terminal stage (kind='closed') skipped → 'none'
 *   - Terminal status ('won','lost') skipped → 'none'
 *   - stageChangedAt before draft.updatedAt → 'none'
 *   - Batch cap respected (limit forwarded to supabase)
 *
 * Mock strategy: the draft candidate pull + the per-draft outcome write moved
 * to Convex (api.agent.drafts.outcomeCandidates / labelOutcome). The Deal +
 * DealStage joins STAY on Supabase. So we drive the drafts via the Convex mock
 * and keep a chainable Supabase thenable (per-table queue) for Deal/DealStage.
 * The label writes surface as labelOutcome mutation calls, recorded for the
 * outcome_signal assertions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Convex mock ─────────────────────────────────────────────────────────────
// outcomeCandidates → the candidate draft list (was the first Supabase read).
// labelOutcome      → records {id, outcomeSignal, checkedAt}; returns
//                     {updated:true}. The route counts advanced/none on a
//                     successful call regardless of the guard, so a plain
//                     resolve is enough; we steer rejections per-test.
let candidateDrafts: unknown[] = [];
const { convexQueryMock, convexMutationMock } = vi.hoisted(() => ({
  convexQueryMock: vi.fn(async (_ref?: unknown, _args?: unknown) => [] as unknown),
  convexMutationMock: vi.fn(async (_ref?: unknown, _args?: unknown) => ({ updated: true }) as unknown),
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

/** The labelOutcome mutation calls (the per-draft outcome writes). */
function labelCalls(): Array<{ path: string; args: Record<string, unknown> }> {
  return convexMutationMock.mock.calls.map(([ref, args]) => ({
    path: typeof ref === 'function' ? (ref as () => string)() : '',
    args: (args ?? {}) as Record<string, unknown>,
  }));
}
/** The fn ref + args of the i-th Convex query call (the candidate pull). */
function queryCall(i = 0): { path: string; args: Record<string, unknown> } {
  const [ref, args] = convexQueryMock.mock.calls[i] as [unknown, Record<string, unknown>];
  return { path: typeof ref === 'function' ? (ref as () => string)() : '', args: (args ?? {}) as Record<string, unknown> };
}

// ── Supabase mock (Deal + DealStage only now) ───────────────────────────────
type Terminal = { data?: unknown; error?: unknown; count?: number | null };
let supabaseQueue: Terminal[] = [];
const supabaseCalls: Array<{ table: string; chain: Array<[string, unknown[]]> }> = [];

vi.mock('@/lib/supabase', () => {
  function makeChain(table: string): Record<string, unknown> {
    const calls: Array<[string, unknown[]]> = [];
    const terminal = supabaseQueue.shift() ?? { data: [], error: null };
    supabaseCalls.push({ table, chain: calls });

    const chain: Record<string, unknown> = {};
    const passthrough = [
      'select',
      'eq',
      'in',
      'is',
      'not',
      'gte',
      'lte',
      'lt',
      'order',
      'limit',
      'update',
    ];
    for (const method of passthrough) {
      chain[method] = vi.fn((...args: unknown[]) => {
        calls.push([method, args]);
        return chain;
      });
    }
    chain.maybeSingle = vi.fn(() => Promise.resolve(terminal));
    chain.single = vi.fn(() => Promise.resolve(terminal));
    chain.then = (resolve: (v: Terminal) => unknown, reject?: (e: unknown) => unknown) => {
      try {
        return Promise.resolve(terminal).then(resolve, reject);
      } catch (e) {
        return reject ? reject(e) : Promise.reject(e);
      }
    };
    return chain;
  }

  return {
    supabase: {
      from: vi.fn((table: string) => makeChain(table)),
    },
  };
});

// Import AFTER mocks so the route picks up mocked supabase.
import { GET } from '@/app/api/cron/draft-outcomes/route';

// ── Env helpers ─────────────────────────────────────────────────────────────
const ENV_KEYS = ['CRON_SECRET', 'CRON_OUTCOMES_DISABLED'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function snapshotEnv() {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.Authorization = authHeader;
  return new Request('http://localhost/api/cron/draft-outcomes', { method: 'GET', headers });
}

function invoke(authHeader?: string) {
  const req = makeRequest(authHeader);
  return GET(req as unknown as Parameters<typeof GET>[0]);
}

type DraftFixture = {
  id: string;
  spaceId: string;
  dealId: string | null;
  updatedAt: string;
};
type DealFixture = {
  id: string;
  status: string;
  stageId: string | null;
  stageChangedAt: string | null;
  updatedAt: string;
};
type StageFixture = { id: string; kind: string | null };

/**
 * Set up a run:
 *   - drafts → the Convex candidate pull (outcomeCandidates)
 *   - Supabase queue holds only the Deal list (if any draft has a dealId) then
 *     the DealStage list (if any deal has a stageId), in route order.
 *   - per-draft outcome writes go to the Convex labelOutcome mutation; override
 *     its behaviour via the optional `labelImpl` (e.g. to reject).
 */
function queueRun(opts: {
  drafts: DraftFixture[];
  deals?: DealFixture[];
  stages?: StageFixture[];
  /** Override the labelOutcome mutation impl (default resolves {updated:true}). */
  labelImpl?: (args: Record<string, unknown>) => Promise<unknown>;
}) {
  candidateDrafts = opts.drafts;

  const queue: Terminal[] = [];
  const hasDealLinks = opts.drafts.some((d) => d.dealId);
  if (hasDealLinks) {
    queue.push({ data: opts.deals ?? [], error: null });
    const hasStageLinks = (opts.deals ?? []).some((d) => d.stageId);
    if (hasStageLinks) {
      queue.push({ data: opts.stages ?? [], error: null });
    }
  }
  supabaseQueue = queue;

  if (opts.labelImpl) {
    const impl = opts.labelImpl;
    convexMutationMock.mockImplementation(async (_ref: unknown, args: unknown) =>
      impl((args ?? {}) as Record<string, unknown>),
    );
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  supabaseQueue = [];
  supabaseCalls.length = 0;
  candidateDrafts = [];
  // outcomeCandidates → candidate drafts; labelOutcome → {updated:true}.
  convexQueryMock.mockImplementation(async () => candidateDrafts);
  convexMutationMock.mockImplementation(async () => ({ updated: true }));

  snapshotEnv();
  process.env.CRON_SECRET = 'test-secret';
  delete process.env.CRON_OUTCOMES_DISABLED;
});

afterEach(() => {
  restoreEnv();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/cron/draft-outcomes', () => {
  it('rejects when Authorization header is missing → 401', async () => {
    const res = await invoke(undefined);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unauthorized' });
    expect(supabaseCalls).toHaveLength(0);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it('rejects when Authorization header carries the wrong secret → 401', async () => {
    const res = await invoke('Bearer wrong-secret');
    expect(res.status).toBe(401);
    expect(supabaseCalls).toHaveLength(0);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it('rejects when CRON_SECRET env var is unset → 500 (server misconfigured)', async () => {
    delete process.env.CRON_SECRET;
    const res = await invoke('Bearer test-secret');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Server misconfigured' });
    expect(supabaseCalls).toHaveLength(0);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it('CRON_OUTCOMES_DISABLED=1 short-circuits → 200 {status:"disabled"}', async () => {
    process.env.CRON_OUTCOMES_DISABLED = '1';
    queueRun({
      drafts: [
        { id: 'd1', spaceId: 's', dealId: 'deal_1', updatedAt: new Date().toISOString() },
      ],
    });

    const res = await invoke('Bearer test-secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'disabled' });
    // Not a single DB read on either side.
    expect(supabaseCalls).toHaveLength(0);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it('no candidate drafts → 200 with zeroed telemetry', async () => {
    queueRun({ drafts: [] });
    const res = await invoke('Bearer test-secret');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.advanced).toBe(0);
    expect(body.none).toBe(0);
    // The candidate pull is now a single Convex query; with no candidates we
    // never touch Supabase (no deals to fetch).
    expect(convexQueryMock).toHaveBeenCalledTimes(1);
    expect(queryCall(0).path).toContain('agent.drafts.outcomeCandidates');
    expect(supabaseCalls).toHaveLength(0);
  });

  it('happy path: deal advanced after draft sent → marks deal_advanced', async () => {
    const sentAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3d ago
    const stageMoved = new Date(Date.now() - 1.5 * 24 * 60 * 60 * 1000).toISOString();
    queueRun({
      drafts: [{ id: 'd1', spaceId: 's', dealId: 'deal_1', updatedAt: sentAt }],
      deals: [
        {
          id: 'deal_1',
          status: 'active',
          stageId: 'stage_1',
          stageChangedAt: stageMoved,
          updatedAt: stageMoved,
        },
      ],
      stages: [{ id: 'stage_1', kind: 'qualified' }],
    });

    const res = await invoke('Bearer test-secret');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.processed).toBe(1);
    expect(body.advanced).toBe(1);
    expect(body.none).toBe(0);

    // The labelOutcome mutation must set outcomeSignal='deal_advanced'.
    const labels = labelCalls();
    expect(labels).toHaveLength(1);
    expect(labels[0].path).toContain('agent.drafts.labelOutcome');
    expect(labels[0].args).toMatchObject({ id: 'd1', outcomeSignal: 'deal_advanced' });
    expect(typeof labels[0].args.checkedAt).toBe('string');
  });

  it('draft with no dealId → marks none (no deal lookup)', async () => {
    const sentAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    queueRun({
      drafts: [{ id: 'd1', spaceId: 's', dealId: null, updatedAt: sentAt }],
      // deals/stages not queued — code path skips them when no dealId exists.
    });

    const res = await invoke('Bearer test-secret');
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.advanced).toBe(0);
    expect(body.none).toBe(1);

    // No Deal or DealStage reads when there's nothing to look up. The draft
    // pull + the label write are both Convex now, so Supabase is never touched.
    expect(supabaseCalls).toHaveLength(0);
    expect(labelCalls()[0].args).toMatchObject({ id: 'd1', outcomeSignal: 'none' });
  });

  it('terminal stage kind=closed → none even if stage changed after sent', async () => {
    const sentAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const stageMoved = new Date(Date.now() - 1.5 * 24 * 60 * 60 * 1000).toISOString();
    queueRun({
      drafts: [{ id: 'd1', spaceId: 's', dealId: 'deal_1', updatedAt: sentAt }],
      deals: [
        {
          id: 'deal_1',
          status: 'active',
          stageId: 'stage_closed',
          stageChangedAt: stageMoved,
          updatedAt: stageMoved,
        },
      ],
      stages: [{ id: 'stage_closed', kind: 'closed' }],
    });

    const res = await invoke('Bearer test-secret');
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.advanced).toBe(0);
    expect(body.none).toBe(1);

    const labels = labelCalls();
    expect(labels[0].args).toMatchObject({ outcomeSignal: 'none' });
  });

  it('terminal deal status (won) → none', async () => {
    const sentAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const stageMoved = new Date(Date.now() - 1.5 * 24 * 60 * 60 * 1000).toISOString();
    queueRun({
      drafts: [{ id: 'd1', spaceId: 's', dealId: 'deal_1', updatedAt: sentAt }],
      deals: [
        {
          id: 'deal_1',
          status: 'won',
          stageId: 'stage_1',
          stageChangedAt: stageMoved,
          updatedAt: stageMoved,
        },
      ],
      stages: [{ id: 'stage_1', kind: 'closing' }],
    });

    const res = await invoke('Bearer test-secret');
    const body = await res.json();
    expect(body.advanced).toBe(0);
    expect(body.none).toBe(1);
  });

  it('stageChangedAt before draft.updatedAt → none (move predates the send)', async () => {
    const sentAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const stageMovedBefore = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    queueRun({
      drafts: [{ id: 'd1', spaceId: 's', dealId: 'deal_1', updatedAt: sentAt }],
      deals: [
        {
          id: 'deal_1',
          status: 'active',
          stageId: 'stage_1',
          stageChangedAt: stageMovedBefore,
          updatedAt: stageMovedBefore,
        },
      ],
      stages: [{ id: 'stage_1', kind: 'qualified' }],
    });

    const res = await invoke('Bearer test-secret');
    const body = await res.json();
    expect(body.advanced).toBe(0);
    expect(body.none).toBe(1);
  });

  it('deal disappeared (no row returned) → none', async () => {
    const sentAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    queueRun({
      drafts: [{ id: 'd1', spaceId: 's', dealId: 'deal_gone', updatedAt: sentAt }],
      deals: [], // empty result for the in-list query
    });

    const res = await invoke('Bearer test-secret');
    const body = await res.json();
    expect(body.advanced).toBe(0);
    expect(body.none).toBe(1);
  });

  it('forwards the 200-row batch cap + the [lower, upper] window to the Convex candidate query', async () => {
    queueRun({ drafts: [] });
    const before = Date.now();
    await invoke('Bearer test-secret');

    // The candidate filter (status='sent', outcome_signal IS NULL) lives inside
    // outcomeCandidates now; the route forwards the cap and the updatedAt window.
    expect(convexQueryMock).toHaveBeenCalledTimes(1);
    const { path, args } = queryCall(0);
    expect(path).toContain('agent.drafts.outcomeCandidates');
    expect(args.limit).toBe(200);

    // Window: lowerBound = now - 8d, upperBound = now - 1d (both ISO strings,
    // lower strictly before upper).
    const lower = new Date(args.lowerBound as string).getTime();
    const upper = new Date(args.upperBound as string).getTime();
    expect(lower).toBeLessThan(upper);
    const DAY = 24 * 60 * 60 * 1000;
    // upper ≈ now - 1 day, lower ≈ now - 8 days (within a few seconds of `before`).
    expect(Math.abs(upper - (before - DAY))).toBeLessThan(5000);
    expect(Math.abs(lower - (before - 8 * DAY))).toBeLessThan(5000);
  });

  it('mixed batch: one advanced + one none + one terminal → counts add up', async () => {
    const sentAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const movedAfter = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const movedBefore = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

    queueRun({
      drafts: [
        { id: 'da', spaceId: 's', dealId: 'deal_a', updatedAt: sentAt },
        { id: 'db', spaceId: 's', dealId: 'deal_b', updatedAt: sentAt },
        { id: 'dc', spaceId: 's', dealId: 'deal_c', updatedAt: sentAt },
      ],
      deals: [
        // deal_a: stage moved AFTER sent → advanced
        {
          id: 'deal_a',
          status: 'active',
          stageId: 'stage_active',
          stageChangedAt: movedAfter,
          updatedAt: movedAfter,
        },
        // deal_b: stage moved BEFORE sent → none
        {
          id: 'deal_b',
          status: 'active',
          stageId: 'stage_active',
          stageChangedAt: movedBefore,
          updatedAt: movedBefore,
        },
        // deal_c: terminal (lost) → none
        {
          id: 'deal_c',
          status: 'lost',
          stageId: 'stage_active',
          stageChangedAt: movedAfter,
          updatedAt: movedAfter,
        },
      ],
      stages: [{ id: 'stage_active', kind: 'qualified' }],
    });

    const res = await invoke('Bearer test-secret');
    const body = await res.json();
    expect(body.processed).toBe(3);
    expect(body.advanced).toBe(1);
    expect(body.none).toBe(2);
    expect(body.errored).toBe(0);
  });
});
