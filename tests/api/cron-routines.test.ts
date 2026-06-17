/**
 * Route-level integration test for `GET /api/cron/routines`.
 *
 * The hourly tick loads every enabled Routine whose nextRunAt has passed,
 * drops the ones whose space has no live subscription, fires a Modal webhook
 * per survivor (bounded to 8 in flight), and stamps lastRunAt/lastRunStatus
 * so the table trigger advances nextRunAt. None of that was tested before
 * this file existed.
 *
 * Mock strategy:
 *   - The due-routine pull + the per-routine stamp moved to Convex
 *     (api.agent.routines.due / stampRun). We drive those via the Convex mock.
 *   - `@/lib/supabase`: chainable thenable, still used for the Space + User
 *     subscription/owner reads. Results come off `supabaseQueue`.
 *   - `globalThis.fetch`: routed by URL — Modal calls recorded for assertion.
 *   - Env vars set in `beforeEach`, restored in `afterEach`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Convex mock ─────────────────────────────────────────────────────────────
// due       → the due routines (was the first Supabase read).
// stampRun  → records {id, spaceId, lastRunStatus}; returns {ok:true}.
let dueRoutines: unknown[] = [];
const { convexQueryMock, convexMutationMock } = vi.hoisted(() => ({
  convexQueryMock: vi.fn(async (_ref?: unknown, _args?: unknown) => [] as unknown),
  convexMutationMock: vi.fn(async (_ref?: unknown, _args?: unknown) => ({ ok: true }) as unknown),
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

/** The stampRun mutation calls. */
function stampCalls(): Array<{ path: string; args: Record<string, unknown> }> {
  return convexMutationMock.mock.calls.map(([ref, args]) => ({
    path: typeof ref === 'function' ? (ref as () => string)() : '',
    args: (args ?? {}) as Record<string, unknown>,
  }));
}
/** The fn ref + args of the i-th Convex query call (the due pull). */
function queryCall(i = 0): { path: string; args: Record<string, unknown> } {
  const [ref, args] = convexQueryMock.mock.calls[i] as [unknown, Record<string, unknown>];
  return { path: typeof ref === 'function' ? (ref as () => string)() : '', args: (args ?? {}) as Record<string, unknown> };
}

// ── Supabase mock (Space + User only now) ───────────────────────────────────
type Terminal = { data?: unknown; error?: unknown; count?: number | null };
let supabaseQueue: Terminal[] = [];
const supabaseCalls: Array<{ table: string; chain: Array<[string, unknown[]]> }> = [];

vi.mock('@/lib/supabase', () => {
  function makeChain(table: string): Record<string, unknown> {
    const calls: Array<[string, unknown[]]> = [];
    const terminal = supabaseQueue.shift() ?? { data: [], error: null };
    supabaseCalls.push({ table, chain: calls });

    const chain: Record<string, unknown> = {};
    const passthrough = ['select', 'eq', 'in', 'lte', 'order', 'limit', 'update'];
    for (const method of passthrough) {
      chain[method] = vi.fn((...args: unknown[]) => {
        calls.push([method, args]);
        return chain;
      });
    }
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
import { GET } from '@/app/api/cron/routines/route';

// ── Env helpers ─────────────────────────────────────────────────────────────
const ENV_KEYS = [
  'CRON_SECRET',
  'CRON_ROUTINES_DISABLED',
  'MODAL_WEBHOOK_URL',
  'AGENT_INTERNAL_SECRET',
] as const;
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

// ── Fetch mock ──────────────────────────────────────────────────────────────
type ModalCall = { url: string; body: unknown };
let modalCalls: ModalCall[] = [];
let modalResponder: (spaceId: string) => Promise<Response> | Response = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 });

function buildFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (process.env.MODAL_WEBHOOK_URL && url === process.env.MODAL_WEBHOOK_URL) {
      let body: unknown = null;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const spaceId = (body as { space_id?: string } | null)?.space_id ?? '';
      modalCalls.push({ url, body });
      return Promise.resolve(modalResponder(spaceId));
    }

    return new Response('unmocked', { status: 599 });
  });
}

let fetchSpy: ReturnType<typeof buildFetchMock>;

// ── Helpers ─────────────────────────────────────────────────────────────────
function invoke(authHeader?: string) {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.Authorization = authHeader;
  const req = new Request('http://localhost/api/cron/routines', { method: 'GET', headers });
  return GET(req as unknown as Parameters<typeof GET>[0]);
}

interface DueRoutine {
  id: string;
  spaceId: string;
  instruction: string;
}

/** Set up a tick: due routines → Convex `due`; Space (with ownerId+sub status)
 *  then User (owner→clerkId) → Supabase queue. Stamps surface as Convex
 *  `stampRun` calls (no queueing needed; the mutation mock resolves {ok:true}). */
function queueTick(opts: {
  due: DueRoutine[];
  activeSpaceIds: string[];
  ownersBySpace?: Record<string, string>;
  clerkIdByOwner?: Record<string, string>;
  runnableCount?: number;
}) {
  dueRoutines = opts.due;
  const spaceRows = opts.due.map((r) => ({
    id: r.spaceId,
    ownerId: opts.ownersBySpace?.[r.spaceId] ?? null,
    stripeSubscriptionStatus: opts.activeSpaceIds.includes(r.spaceId) ? 'active' : 'cancelled',
  }));
  const ownerIds = Object.values(opts.ownersBySpace ?? {});
  const userRows = ownerIds.map((id) => ({ id, clerkId: opts.clerkIdByOwner?.[id] ?? null }));
  const queue: Terminal[] = [{ data: spaceRows, error: null }];
  // The User lookup only runs when at least one active space has an ownerId;
  // mirror the route's branch so we don't queue a phantom response.
  if (ownerIds.length > 0) {
    queue.push({ data: userRows, error: null });
  }
  supabaseQueue = queue;
}

beforeEach(() => {
  vi.clearAllMocks();
  supabaseQueue = [];
  supabaseCalls.length = 0;
  dueRoutines = [];
  // due → the per-test due routines; stampRun → {ok:true}.
  convexQueryMock.mockImplementation(async () => dueRoutines);
  convexMutationMock.mockImplementation(async () => ({ ok: true }));
  modalCalls = [];
  modalResponder = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

  snapshotEnv();
  process.env.CRON_SECRET = 'test-secret';
  delete process.env.CRON_ROUTINES_DISABLED;
  process.env.MODAL_WEBHOOK_URL = 'https://modal.example/webhook';
  process.env.AGENT_INTERNAL_SECRET = 'agent-secret';

  fetchSpy = buildFetchMock();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllGlobals();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/cron/routines', () => {
  it('rejects a missing Authorization header → 401, no DB or Modal calls', async () => {
    const res = await invoke(undefined);
    expect(res.status).toBe(401);
    expect(modalCalls).toHaveLength(0);
    expect(supabaseCalls).toHaveLength(0);
  });

  it('rejects the wrong secret → 401', async () => {
    const res = await invoke('Bearer nope');
    expect(res.status).toBe(401);
    expect(modalCalls).toHaveLength(0);
  });

  it('missing CRON_SECRET env → 500 server misconfigured', async () => {
    delete process.env.CRON_SECRET;
    const res = await invoke('Bearer test-secret');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Server misconfigured' });
  });

  it('CRON_ROUTINES_DISABLED short-circuits → 200 disabled, no DB read', async () => {
    process.env.CRON_ROUTINES_DISABLED = '1';
    queueTick({ due: [{ id: 'r1', spaceId: 's1', instruction: 'do the thing' }], activeSpaceIds: ['s1'] });
    const res = await invoke('Bearer test-secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'disabled' });
    expect(supabaseCalls).toHaveLength(0);
    expect(convexQueryMock).not.toHaveBeenCalled();
    expect(modalCalls).toHaveLength(0);
  });

  it('no due routines → 200 zeroed, no Modal calls', async () => {
    queueTick({ due: [], activeSpaceIds: [] });
    const res = await invoke('Bearer test-secret');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.due).toBe(0);
    expect(body.fired).toBe(0);
    expect(modalCalls).toHaveLength(0);
    // Only the Convex due-query ran; the Space query is skipped on empty, and
    // the due pull no longer touches Supabase.
    expect(queryCall(0).path).toContain('agent.routines.due');
    expect(supabaseCalls).toHaveLength(0);
  });

  it('the due query is scoped to nextRunAt <= now (Convex due pull)', async () => {
    queueTick({ due: [], activeSpaceIds: [] });
    const before = Date.now();
    await invoke('Bearer test-secret');
    // The enabled=true + nextRunAt<=now filter lives inside the Convex `due`
    // query now; the route forwards `now` (ISO, ~current) and the per-tick cap.
    const { path, args } = queryCall(0);
    expect(path).toContain('agent.routines.due');
    expect(typeof args.now).toBe('string');
    expect(Math.abs(new Date(args.now as string).getTime() - before)).toBeLessThan(5000);
    expect(args.limit).toBe(250);
  });

  it('a due routine in an active space → fires Modal with the instruction and stamps lastRun', async () => {
    queueTick({
      due: [{ id: 'r1', spaceId: 's1', instruction: 'draft a check-in for quiet deals' }],
      activeSpaceIds: ['s1'],
    });

    const res = await invoke('Bearer test-secret');
    const body = await res.json();
    expect(body.due).toBe(1);
    expect(body.fired).toBe(1);
    expect(body.errored).toBe(0);
    expect(body.skipped).toBe(0);

    expect(modalCalls).toHaveLength(1);
    // user_id is only added when the owner's clerkId resolved — left absent
    // here so the cron body matches the original contract.
    expect(modalCalls[0].body).toEqual({
      space_id: 's1',
      secret: 'agent-secret',
      instruction: 'draft a check-in for quiet deals',
    });

    // The cron stamped the routine via the Convex stampRun mutation, scoped to
    // (id, spaceId), with lastRunStatus='ok'. (lastRunAt is set inside the
    // mutation now, not passed by the route.)
    const stamps = stampCalls();
    expect(stamps).toHaveLength(1);
    expect(stamps[0].path).toContain('agent.routines.stampRun');
    expect(stamps[0].args).toMatchObject({ id: 'r1', spaceId: 's1', lastRunStatus: 'ok' });
  });

  it('threads the owner Clerk userId into the Modal payload when known', async () => {
    queueTick({
      due: [{ id: 'r1', spaceId: 's1', instruction: 'do the thing' }],
      activeSpaceIds: ['s1'],
      ownersBySpace: { s1: 'owner-db-1' },
      clerkIdByOwner: { 'owner-db-1': 'user_clerk_abc' },
    });

    const res = await invoke('Bearer test-secret');
    expect(res.status).toBe(200);
    expect(modalCalls).toHaveLength(1);
    expect(modalCalls[0].body).toMatchObject({
      space_id: 's1',
      user_id: 'user_clerk_abc',
      instruction: 'do the thing',
    });
  });

  it('a due routine whose space has no live subscription is skipped — no Modal call', async () => {
    queueTick({
      due: [
        { id: 'r_live', spaceId: 's_live', instruction: 'live space routine' },
        { id: 'r_churned', spaceId: 's_churned', instruction: 'churned space routine' },
      ],
      activeSpaceIds: ['s_live'], // s_churned absent → inactive
      runnableCount: 1,
    });

    const res = await invoke('Bearer test-secret');
    const body = await res.json();
    expect(body.due).toBe(2);
    expect(body.fired).toBe(1);
    expect(body.skipped).toBe(1);
    expect(modalCalls.map((c) => (c.body as { space_id: string }).space_id)).toEqual(['s_live']);
  });

  it('a Modal HTTP 500 marks the routine errored but still stamps it', async () => {
    queueTick({
      due: [{ id: 'r1', spaceId: 's1', instruction: 'something' }],
      activeSpaceIds: ['s1'],
    });
    modalResponder = () => new Response('upstream blew up', { status: 500 });

    const res = await invoke('Bearer test-secret');
    const body = await res.json();
    expect(body.fired).toBe(0);
    expect(body.errored).toBe(1);

    // Even a failed dispatch stamps the row (via Convex stampRun) so nextRunAt
    // advances and a permanently failing routine can't jam the queue.
    const stamps = stampCalls();
    expect(stamps).toHaveLength(1);
    expect(stamps[0].args.lastRunStatus).toBe('error');
  });

  it('caps Modal dispatches at 8 in flight even with 20 due routines', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    modalResponder = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const due = Array.from({ length: 20 }, (_, i) => ({
      id: `r${i}`,
      spaceId: `s${i}`,
      instruction: `routine ${i}`,
    }));
    queueTick({ due, activeSpaceIds: due.map((r) => r.spaceId) });

    const res = await invoke('Bearer test-secret');
    const body = await res.json();
    expect(body.fired).toBe(20);
    expect(modalCalls).toHaveLength(20);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });
});
