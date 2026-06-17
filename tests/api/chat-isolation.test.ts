/**
 * Threat-model test suite for the seller / manager conversation isolation
 * boundary.
 *
 * The threat: manager-Cola and company team chats share the `Conversation`
 * table with seller conversations, keyed by `spaceId` and distinguished only
 * by a reserved title prefix. A manager_owner also owns their personal seller
 * space, so space ownership ALONE does not isolate the two surfaces. Without an
 * explicit reserved-title guard, a seller (or a manager hitting the seller
 * endpoints) could read or mutate manager-side conversations through the seller
 * routes.
 *
 * Conversation + Message persistence moved from Supabase to Convex
 * (convex/conversations/{conversations,messages}.ts). The routes now read those
 * rows via convex().query(api.conversations.*) and still read User/Space
 * ownership from Supabase. So this suite drives the conversation/message side
 * through a Convex mock (branching on the fn path) and keeps the Supabase mock
 * for the User/Space ownership lookups the routes still perform.
 *
 * The seller list's reserved-prefix exclusion also moved one hop: Convex has no
 * `NOT LIKE`, so listBySpace returns the space's rows and the route drops
 * reserved titles in memory (lib/chat/conversation-access). The old test
 * asserted the DB-layer `.not('title','like', …)` filters; we now assert the
 * observable equivalent — a seeded reserved row never reaches the response.
 *
 * Every test here CROSSES the boundary on purpose and asserts denial:
 *   - GET /api/ai/messages on a [MANAGER_COLA] conv  -> 404, no message rows
 *   - GET /api/ai/messages on a [COMPANY_CHAT] conv -> 404, no message rows
 *   - GET /api/ai/conversations (seller list) excludes BOTH reserved prefixes
 *   - PATCH /api/ai/conversations/[id] on a [MANAGER_COLA] conv -> 404
 *   - DELETE /api/ai/conversations/[id] on a [MANAGER_COLA] conv -> 404
 *
 * These must FAIL if the guards are reverted and PASS on the current code.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (declared before importing the routes) ────────────────────────────

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: 'user_clerk_123' })),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99 })),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/space', () => ({
  getSpaceFromSlug: vi.fn(async () => ({ id: 's_seller_1', slug: 'jane', ownerId: 'u_1' })),
}));

// ── Convex mock — Conversation + Message reads ──────────────────────────────
//
// The routes call convex().query against api.conversations.{conversations,
// messages}.*. We steer each call by branching on the fn path (call the path
// proxy: `typeof ref === 'function' ? ref() : ''`). Per scenario the test seeds:
//   - convexState.conversation : the row api.conversations.conversations.getById
//                                returns (or null)
//   - convexState.list         : rows api.conversations.conversations.listBySpace
//                                returns (the route filters reserved in memory)
//   - convexState.messages     : rows api.conversations.messages.listForConversation
//                                returns
//   - convexState.preview      : the { [conversationId]: content } map
//                                api.conversations.messages.latestPreviewContent
//                                returns

type ConvRow = { id: string; spaceId: string; title: string };
type MsgRow = { id: string; role: string; content: string; blocks: unknown; createdAt: string };

const convexState: {
  conversation: ConvRow | null;
  list: ConvRow[];
  messages: MsgRow[];
  preview: Record<string, string>;
} = { conversation: null, list: [], messages: [], preview: {} };

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

// ── Supabase mock (User + Space ownership only) ─────────────────────────────
//
// A per-table response queue. Each table name maps to a FIFO list of results
// that successive queries against that table resolve to (either via
// `.maybeSingle()` / `.single()` or by awaiting the chain directly). The
// Conversation/Message tables moved to Convex, so only User and Space flow
// through here now — but the queue keeps any table name for safety.

type TableResult = { data?: unknown; error?: unknown };

const tableQueues: Record<string, TableResult[]> = {};

function seedTable(table: string, ...results: TableResult[]) {
  tableQueues[table] = (tableQueues[table] ?? []).concat(results);
}

function nextResult(table: string): TableResult {
  const q = tableQueues[table];
  if (q && q.length > 0) return q.shift() as TableResult;
  // Default: no rows. The route treats this as "not found" / empty.
  return { data: null };
}

function makeChain(table: string) {
  // `result` is resolved lazily on the terminal call so that the chain can be
  // built first and the queued result pulled when the query actually runs.
  const chain: Record<string, unknown> = {};
  const passthroughMethods = ['select', 'eq', 'order', 'limit', 'in', 'insert', 'update', 'delete', 'not'];
  for (const m of passthroughMethods) {
    chain[m] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(() => Promise.resolve(nextResult(table)));
  chain.single = vi.fn(() => Promise.resolve(nextResult(table)));
  // Awaiting the chain directly (list queries) resolves the next result.
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(nextResult(table)).then(resolve);
  return chain;
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn((table: string) => makeChain(table)) },
}));

// Import AFTER the mocks.
import { GET as getMessages } from '@/app/api/ai/messages/route';
import { GET as getConversations } from '@/app/api/ai/conversations/route';
import { PATCH as patchConversation, DELETE as deleteConversation } from '@/app/api/ai/conversations/[id]/route';

// ── Convex steering ─────────────────────────────────────────────────────────
// Wire the query mock to the per-scenario convexState, branching on fn path.
function wireConvex() {
  convexQueryMock.mockImplementation(async (ref: unknown) => {
    const p = typeof ref === 'function' ? (ref as () => string)() : '';
    if (p.includes('conversations.getById')) return convexState.conversation;
    if (p.includes('conversations.listBySpace')) return convexState.list;
    if (p.includes('messages.listForConversation')) return convexState.messages;
    if (p.includes('messages.latestPreviewContent')) return convexState.preview;
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(tableQueues)) delete tableQueues[k];
  convexState.conversation = null;
  convexState.list = [];
  convexState.messages = [];
  convexState.preview = {};
  wireConvex();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

// The routes read `req.nextUrl.searchParams`, a NextRequest product a plain
// Request does not have. We hand them a minimal stand-in with `nextUrl` and a
// `json()` body reader, which is all these handlers touch.
function nextRequest(url: string, body?: Record<string, unknown>) {
  return {
    nextUrl: new URL(url),
    json: async () => body ?? {},
  };
}

function messagesRequest(conversationId: string) {
  return nextRequest(
    `http://localhost/api/ai/messages?conversationId=${encodeURIComponent(conversationId)}`,
  ) as unknown as Parameters<typeof getMessages>[0];
}

function conversationsRequest(slug = 'jane') {
  return nextRequest(
    `http://localhost/api/ai/conversations?slug=${encodeURIComponent(slug)}`,
  ) as unknown as Parameters<typeof getConversations>[0];
}

function idRequest(body?: Record<string, unknown>) {
  return nextRequest('http://localhost/api/ai/conversations/c_1', body) as unknown as Parameters<typeof patchConversation>[0];
}

const idParams = { params: Promise.resolve({ id: 'c_manager_1' }) };

// ── GET /api/ai/messages ────────────────────────────────────────────────────

describe('GET /api/ai/messages — manager/team conversations are denied', () => {
  it('404s a [MANAGER_COLA] conversation and returns NO message rows', async () => {
    // The caller legitimately owns the space (manager_owner owns their seller
    // space). Ownership passes; the reserved-title guard is what denies.
    convexState.conversation = { id: 'c_manager_1', spaceId: 's_seller_1', title: '[MANAGER_COLA] private notes' };
    seedTable('User', { data: { id: 'u_1' } });
    seedTable('Space', { data: { id: 's_seller_1', ownerId: 'u_1' } });
    // If the guard were missing, this is the row set that would leak.
    convexState.messages = [{ id: 'm_1', role: 'assistant', content: 'manager secret', blocks: null, createdAt: '2026-01-01' }];

    const res = await getMessages(messagesRequest('c_manager_1'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('manager secret');
  });

  it('404s a [COMPANY_CHAT] conversation and returns NO message rows', async () => {
    convexState.conversation = { id: 'c_team_1', spaceId: 's_seller_1', title: '[COMPANY_CHAT] team room' };
    seedTable('User', { data: { id: 'u_1' } });
    seedTable('Space', { data: { id: 's_seller_1', ownerId: 'u_1' } });
    convexState.messages = [{ id: 'm_1', role: 'assistant', content: 'team secret', blocks: null, createdAt: '2026-01-01' }];

    const res = await getMessages(messagesRequest('c_team_1'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('team secret');
  });

  it('serves a plain seller conversation (control: the guard is not over-broad)', async () => {
    convexState.conversation = { id: 'c_seller_1', spaceId: 's_seller_1', title: 'Follow up with the Garcias' };
    seedTable('User', { data: { id: 'u_1' } });
    seedTable('Space', { data: { id: 's_seller_1', ownerId: 'u_1' } });
    convexState.messages = [{ id: 'm_1', role: 'user', content: 'hi', blocks: null, createdAt: '2026-01-01' }];

    const res = await getMessages(messagesRequest('c_seller_1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
  });
});

// ── GET /api/ai/conversations (seller list) ────────────────────────────────

describe('GET /api/ai/conversations — list excludes BOTH reserved prefixes', () => {
  it('drops reserved-prefix rows the listBySpace query returns', async () => {
    // Convex has no NOT LIKE, so listBySpace returns the space's rows including
    // reserved ones; the route filters them in memory. Seed a manager + team +
    // plain row and assert ONLY the plain seller row survives — the observable
    // equivalent of the old `.not('title','like', prefix)` DB filters.
    seedTable('User', { data: { id: 'u_1' } });
    convexState.list = [
      { id: 'c_manager_1', spaceId: 's_seller_1', title: '[MANAGER_COLA] private notes' },
      { id: 'c_team_1', spaceId: 's_seller_1', title: '[COMPANY_CHAT] team room' },
      { id: 'c_seller_1', spaceId: 's_seller_1', title: 'Garcias' },
    ];
    convexState.preview = {}; // no previews needed

    const res = await getConversations(conversationsRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    const titles = (body as { title: string }[]).map((c) => c.title);
    expect(titles).toEqual(['Garcias']);
    expect(titles).not.toContain('[MANAGER_COLA] private notes');
    expect(titles).not.toContain('[COMPANY_CHAT] team room');
  });

  it('does not return a seeded manager row in the seller list', async () => {
    // Confirm the route surfaces exactly what the (filtered) query returns and
    // nothing extra: a plain row passes, while a co-seeded manager + team row
    // are excluded by the in-memory reserved-title filter.
    seedTable('User', { data: { id: 'u_1' } });
    convexState.list = [
      { id: 'c_seller_1', spaceId: 's_seller_1', title: 'Garcias' },
      { id: 'c_manager_1', spaceId: 's_seller_1', title: '[MANAGER_COLA] private notes' },
      { id: 'c_team_1', spaceId: 's_seller_1', title: '[COMPANY_CHAT] team room' },
    ];
    convexState.preview = { c_seller_1: 'hi' }; // preview lookup

    const res = await getConversations(conversationsRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    const titles = (body as { title: string }[]).map((c) => c.title);
    expect(titles).not.toContain('[MANAGER_COLA] private notes');
    expect(titles).not.toContain('[COMPANY_CHAT] team room');
  });
});

// ── PATCH / DELETE /api/ai/conversations/[id] ───────────────────────────────

describe('PATCH /api/ai/conversations/[id] — manager conversation denied', () => {
  it('404s renaming a [MANAGER_COLA] conversation even when ownership matches', async () => {
    // Ownership passes (Space.ownerId -> matching User). The reserved-title
    // guard is what denies the rename.
    convexState.conversation = { id: 'c_manager_1', spaceId: 's_seller_1', title: '[MANAGER_COLA] private' };
    seedTable('Space', { data: { ownerId: 'u_1' } });
    seedTable('User', { data: { id: 'u_1' } });

    const res = await patchConversation(idRequest({ title: 'hijacked' }), idParams);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/ai/conversations/[id] — manager conversation denied', () => {
  it('404s deleting a [MANAGER_COLA] conversation even when ownership matches', async () => {
    convexState.conversation = { id: 'c_manager_1', spaceId: 's_seller_1', title: '[MANAGER_COLA] private' };
    seedTable('Space', { data: { ownerId: 'u_1' } });
    seedTable('User', { data: { id: 'u_1' } });

    const res = await deleteConversation(idRequest(), idParams);
    expect(res.status).toBe(404);
  });

  it('404s deleting a [COMPANY_CHAT] conversation even when ownership matches', async () => {
    convexState.conversation = { id: 'c_team_1', spaceId: 's_seller_1', title: '[COMPANY_CHAT] team' };
    seedTable('Space', { data: { ownerId: 'u_1' } });
    seedTable('User', { data: { id: 'u_1' } });

    const res = await deleteConversation(idRequest(), idParams);
    expect(res.status).toBe(404);
  });
});
