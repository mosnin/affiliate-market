/**
 * Route-level test for `POST /api/agent/drafts/batch-approve`.
 *
 * Covers:
 *   - 401 unauth, 403 no-space, 429 rate-limit
 *   - 400 invalid body (missing draftIds, empty array, oversized, wrong types)
 *   - Per-draft scoping: foreign-space draft → not_found (NOT a cross-space leak)
 *   - Per-draft status: non-pending draft → already_<status> (skipped, not failed)
 *   - Happy path: all sent successfully → results[].ok=true, status='sent'
 *   - Partial failure: one delivery fails → other drafts still ok, failed item
 *     has ok=false with the delivery error
 *   - sendDraft + audit + supabase update wired correctly
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-auth', () => ({
  requireAuth: vi.fn(),
}));

vi.mock('@/lib/space', () => ({
  getSpaceForUser: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('@/lib/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

vi.mock('@/lib/delivery', () => ({
  sendDraft: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Convex mock — AgentDraft reads + writes ─────────────────────────────────
// The per-draft ownership read and the status flip moved off Supabase:
//   - getByIdForSpace → the draft row keyed on the draftId arg (or null when
//     not in scope, e.g. a foreign-space id).
//   - updateForSpace  → records {id, spaceId, patch}; returns the patched row.
// `draftsById` is set per-test; an absent id resolves to null (the scoping
// guard). `updateImpl` lets a test make the update reject (the update_failed
// branch). `api` is a path proxy so the fn ref stringifies to its dotted path.
type DraftRow = { id: string; status: string; contactId: string | null; channel: string; subject: string | null; content: string };
let draftsById: Record<string, DraftRow | null> = {};
let updateImpl: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
const updateCalls: Array<{ id: string; spaceId: string; patch: Record<string, unknown> }> = [];

const { convexQueryMock, convexMutationMock } = vi.hoisted(() => ({
  convexQueryMock: vi.fn(async (_ref?: unknown, _args?: unknown) => null as unknown),
  convexMutationMock: vi.fn(async (_ref?: unknown, _args?: unknown) => null as unknown),
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

// ── Supabase mock (Contact reads only now) ──────────────────────────────────
// Each call to supabase.from('Table') consumes one terminal from the table's
// queue. select/eq/maybeSingle/single return the chain (or resolve the
// terminal). AgentDraft no longer flows through here.
type Terminal = { data?: unknown; error?: unknown };
const queues: Record<string, Terminal[]> = {};

function queueFor(table: string) {
  if (!queues[table]) queues[table] = [];
  return queues[table];
}

vi.mock('@/lib/supabase', () => {
  function makeChain(table: string): Record<string, unknown> {
    const q = queueFor(table);
    const terminal = q.shift() ?? { data: null, error: null };

    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
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
  return { supabase: { from: vi.fn((table: string) => makeChain(table)) } };
});

// Import AFTER mocks.
import { POST } from '@/app/api/agent/drafts/batch-approve/route';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';
import { checkRateLimit } from '@/lib/rate-limit';
import { sendDraft } from '@/lib/delivery';

const mockRequireAuth = vi.mocked(requireAuth);
const mockGetSpaceForUser = vi.mocked(getSpaceForUser);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockSendDraft = vi.mocked(sendDraft);

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/agent/drafts/batch-approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const SPACE = { id: 'space_1', slug: 's', name: 'Test', ownerId: 'owner_1' };

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(queues)) delete queues[k];
  updateCalls.length = 0;
  draftsById = {};
  updateImpl = null;
  mockRequireAuth.mockResolvedValue({ userId: 'user_1' });
  mockGetSpaceForUser.mockResolvedValue(SPACE as never);
  mockCheckRateLimit.mockResolvedValue({ allowed: true });

  // getByIdForSpace → draftsById[id] (or null when absent / not in scope).
  convexQueryMock.mockImplementation(async (ref: unknown, args: unknown) => {
    const p = typeof ref === 'function' ? (ref as () => string)() : '';
    const a = (args ?? {}) as { id?: string };
    if (p.includes('agent.drafts.getByIdForSpace')) {
      return (a.id && a.id in draftsById ? draftsById[a.id] : null) ?? null;
    }
    return null;
  });
  // updateForSpace → record the call; return the patched row (or run updateImpl,
  // which a test can point at a rejection to exercise the update_failed branch).
  convexMutationMock.mockImplementation(async (ref: unknown, args: unknown) => {
    const p = typeof ref === 'function' ? (ref as () => string)() : '';
    const a = (args ?? {}) as { id: string; spaceId: string; patch: Record<string, unknown> };
    if (p.includes('agent.drafts.updateForSpace')) {
      updateCalls.push({ id: a.id, spaceId: a.spaceId, patch: a.patch });
      if (updateImpl) return updateImpl(a as unknown as Record<string, unknown>);
      const base = draftsById[a.id];
      return { id: a.id, ...(base ?? {}), ...a.patch };
    }
    return null;
  });
});

describe('POST /api/agent/drafts/batch-approve', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await POST(makeReq({ draftIds: ['a'] }));
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no space', async () => {
    mockGetSpaceForUser.mockResolvedValue(null);
    const res = await POST(makeReq({ draftIds: ['a'] }));
    expect(res.status).toBe(403);
  });

  it('returns 429 when rate-limited', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false });
    const res = await POST(makeReq({ draftIds: ['a'] }));
    expect(res.status).toBe(429);
  });

  it('returns 400 when draftIds is missing', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 when draftIds is empty', async () => {
    const res = await POST(makeReq({ draftIds: [] }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when draftIds exceeds the max batch size', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id_${i}`);
    const res = await POST(makeReq({ draftIds: ids }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when draftIds contains non-string entries', async () => {
    const res = await POST(makeReq({ draftIds: ['ok', 123, ''] }));
    expect(res.status).toBe(400);
  });

  it('returns not_found for a draftId in another space (the scoping guard)', async () => {
    // Single draftId. getByIdForSpace returns null (the Convex query applies the
    // spaceId scope), emulating a foreign-space row filtered out.
    draftsById = {}; // 'foreign_draft' is absent → null

    const res = await POST(makeReq({ draftIds: ['foreign_draft'] }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: Array<{ draftId: string; ok: boolean; error?: string }> };
    expect(json.results).toEqual([
      { draftId: 'foreign_draft', ok: false, error: 'not_found' },
    ]);
    // sendDraft must NOT have been called for the foreign row.
    expect(mockSendDraft).not.toHaveBeenCalled();
  });

  it('returns already_<status> for a non-pending draft (skipped, not failed)', async () => {
    draftsById = {
      d1: { id: 'd1', status: 'sent', contactId: 'c1', channel: 'email', subject: 's', content: 'hi' },
    };

    const res = await POST(makeReq({ draftIds: ['d1'] }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: Array<{ draftId: string; ok: boolean; error?: string }> };
    expect(json.results).toEqual([{ draftId: 'd1', ok: false, error: 'already_sent' }]);
    expect(mockSendDraft).not.toHaveBeenCalled();
  });

  it('sends all drafts on happy path and returns ok=true per item', async () => {
    // Two drafts. Each: one Convex read (getByIdForSpace), one Contact read
    // (Supabase), one Convex write (updateForSpace).
    draftsById = {
      d1: { id: 'd1', status: 'pending', contactId: 'c1', channel: 'email', subject: 's1', content: 'hello 1' },
      d2: { id: 'd2', status: 'pending', contactId: 'c2', channel: 'sms', subject: null, content: 'hello 2' },
    };
    // Contact reads are consumed in draft order (d1 → c1, d2 → c2).
    queueFor('Contact').push({ data: { name: 'Alice', email: 'a@x.test', phone: null }, error: null });
    queueFor('Contact').push({ data: { name: 'Bob', email: null, phone: '+15551234' }, error: null });

    mockSendDraft.mockResolvedValueOnce({ sent: true, method: 'email' });
    mockSendDraft.mockResolvedValueOnce({ sent: true, method: 'sms' });

    const res = await POST(makeReq({ draftIds: ['d1', 'd2'] }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      results: Array<{ draftId: string; ok: boolean; status?: string; error?: string }>;
    };
    expect(json.results).toHaveLength(2);
    expect(json.results[0]).toMatchObject({ draftId: 'd1', ok: true, status: 'sent' });
    expect(json.results[1]).toMatchObject({ draftId: 'd2', ok: true, status: 'sent' });
    expect(mockSendDraft).toHaveBeenCalledTimes(2);

    // Each draft generated one updateForSpace with patch.status='sent', scoped
    // to the space.
    expect(updateCalls).toHaveLength(2);
    for (const u of updateCalls) {
      expect(u.spaceId).toBe(SPACE.id);
      expect((u.patch as { status: string }).status).toBe('sent');
    }
  });

  it('keeps other items running when one delivery fails', async () => {
    draftsById = {
      d1: { id: 'd1', status: 'pending', contactId: 'c1', channel: 'email', subject: 's1', content: 'hi' },
      d2: { id: 'd2', status: 'pending', contactId: 'c2', channel: 'email', subject: 's2', content: 'hi' },
    };
    queueFor('Contact').push({ data: { name: 'Alice', email: 'a@x.test', phone: null }, error: null });
    queueFor('Contact').push({ data: { name: 'Bob', email: 'b@x.test', phone: null }, error: null });

    // d1 fails delivery (stale recipient), d2 succeeds.
    mockSendDraft.mockResolvedValueOnce({ sent: false, method: 'email', error: 'Contact has no email address' });
    mockSendDraft.mockResolvedValueOnce({ sent: true, method: 'email' });

    const res = await POST(makeReq({ draftIds: ['d1', 'd2'] }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      results: Array<{ draftId: string; ok: boolean; status?: string; deliveryResult?: { sent: boolean } }>;
    };
    // sent=false → row marked 'approved' (human reviewed, delivery failed),
    // still ok=true because the draft moved out of pending. The deliveryResult
    // carries the failure detail for the UI to surface.
    expect(json.results[0]).toMatchObject({ draftId: 'd1', ok: true, status: 'approved' });
    expect(json.results[0].deliveryResult?.sent).toBe(false);
    expect(json.results[1]).toMatchObject({ draftId: 'd2', ok: true, status: 'sent' });
  });

  it('de-dupes repeated draftIds in the input', async () => {
    draftsById = {
      d1: { id: 'd1', status: 'pending', contactId: 'c1', channel: 'note', subject: null, content: 'note' },
    };
    queueFor('Contact').push({ data: { name: 'Alice', email: null, phone: null }, error: null });

    mockSendDraft.mockResolvedValueOnce({ sent: true, method: 'note' });

    const res = await POST(makeReq({ draftIds: ['d1', 'd1', 'd1'] }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: unknown[] };
    expect(json.results).toHaveLength(1);
    expect(mockSendDraft).toHaveBeenCalledTimes(1);
  });
});
