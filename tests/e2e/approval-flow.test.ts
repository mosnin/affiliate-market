/**
 * E2E integration tests for the approval flow.
 *
 * Tests the GET and POST /api/agent/approvals route handlers end-to-end:
 *   - GET: surfaces paused tasks with approvalRequired metadata
 *   - POST approve: transitions paused → queued, stamps approvedAt + approvedBy
 *   - POST reject: transitions paused → cancelled, stamps rejectedAt + rejectedBy + rejectionReason
 *   - Auth: wrong user gets 403/404
 *
 * The AgentTask reads/writes moved from Supabase to Convex:
 *   - GET  lists via convex().query(api.agent.tasks.listPendingApprovals, …)
 *   - POST reads the task via convex().query(api.agent.tasks.getById, …) for
 *     the ownership (spaceId) + paused-status gate, then writes via
 *     convex().mutation(api.agent.tasks.setStatusAndMetadata, …) which returns
 *     the updated row (the route responds with `{ task: <that row> }`).
 *
 * Mock strategy:
 *   - @/lib/api-auth       → vi.mock: controls requireAuth() return value
 *   - @/lib/space          → vi.mock: controls getSpaceForUser() return value
 *   - @/lib/convex-server  → query/mutation mocks steered per test via FIFO
 *                            queues, branched on the dotted fn path. `api` is a
 *                            path proxy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ── Convex queue-based mock ───────────────────────────────────────────────────
//
// Each POST walks getById (the gate) then setStatusAndMetadata (the write);
// GET issues a single listPendingApprovals query. We branch the query mock by
// fn path so listPendingApprovals and getById can be queued independently, and
// drive the write off its own queue.

type ConvexResult = { value?: unknown; error?: unknown };
let listQueue: ConvexResult[] = [];    // answers listPendingApprovals (GET)
let getByIdQueue: ConvexResult[] = []; // answers getById (POST gate)
let updateQueue: ConvexResult[] = [];  // answers setStatusAndMetadata (POST write)

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

function fnPath(ref: unknown): string {
  return typeof ref === 'function' ? (ref as () => string)() : '';
}

/** Resolve `value`, or throw `error` (mirrors a Convex call throwing). */
function settle(next: ConvexResult | undefined, fallback: unknown): Promise<unknown> {
  if (!next) return Promise.resolve(fallback);
  if (next.error) {
    return Promise.reject(next.error instanceof Error ? next.error : new Error(String(next.error)));
  }
  return Promise.resolve(next.value);
}

// ── Auth mock ─────────────────────────────────────────────────────────────────

vi.mock('@/lib/api-auth', () => ({
  requireAuth: vi.fn(),
}));

// ── Space mock ────────────────────────────────────────────────────────────────

vi.mock('@/lib/space', () => ({
  getSpaceForUser: vi.fn(),
}));

// ── Kill-switch mock ──────────────────────────────────────────────────────────
// The route gates on `assertSpaceEnabled` (added in the agent-trigger work);
// we no-op it for the happy path. The "space is disabled" failure mode is
// covered by checking the route's gate logic in dedicated kill-switch tests,
// not here.

vi.mock('@/lib/agent/kill-switch', () => ({
  assertSpaceEnabled: vi.fn(async () => undefined),
}));

// Import AFTER all mocks are registered.
import { GET, POST } from '@/app/api/agent/approvals/route';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';
import type { Space } from '@/lib/types';

const mockRequireAuth = vi.mocked(requireAuth);
const mockGetSpaceForUser = vi.mocked(getSpaceForUser);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SPACE_ID = 'space-approval-001';
const USER_ID = 'user_approver_abc';

const fakeSpace = {
  id: SPACE_ID,
  slug: 'approval-space',
  name: 'Approval Space',
  ownerId: USER_ID,
} as unknown as Space;

/** A minimal paused task with approvalRequired set in metadata */
const fakePausedTask = {
  id: 'task-paused-001',
  spaceId: SPACE_ID,
  status: 'paused',
  title: 'Send offer to Maria',
  metadata: {
    approvalRequired: true,
    pendingAction: 'send_email',
  },
  createdAt: '2026-05-06T09:00:00.000Z',
  updatedAt: '2026-05-06T09:00:00.000Z',
};

// ── Request helpers ───────────────────────────────────────────────────────────

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost/api/agent/approvals', { method: 'GET' });
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/agent/approvals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Setup ────────────────────────────────────────────────────────────────────

/** Queue the GET listPendingApprovals result. */
function queueList(result: ConvexResult) {
  listQueue.push(result);
}
/** Queue the POST getById (gate) result. */
function queueGetById(result: ConvexResult) {
  getByIdQueue.push(result);
}
/** Queue the POST setStatusAndMetadata (write) result. */
function queueUpdate(result: ConvexResult) {
  updateQueue.push(result);
}

beforeEach(() => {
  vi.clearAllMocks();
  listQueue = [];
  getByIdQueue = [];
  updateQueue = [];

  convexQueryMock.mockImplementation(async (ref: unknown) => {
    const path = fnPath(ref);
    if (path.includes('listPendingApprovals')) return settle(listQueue.shift(), []);
    // getById (the POST gate).
    return settle(getByIdQueue.shift(), null);
  });

  convexMutationMock.mockImplementation(async (ref: unknown) => {
    const path = fnPath(ref);
    if (path.includes('setStatusAndMetadata')) return settle(updateQueue.shift(), null);
    return null;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/agent/approvals — pending approval detection
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/agent/approvals', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no space', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(null as never);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('identifies tasks with approvalRequired metadata as pending approvals', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(fakeSpace);

    // The route queries paused tasks with approvalRequired present (Convex).
    queueList({ value: [fakePausedTask] });

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe('task-paused-001');
    expect(body.tasks[0].status).toBe('paused');
    expect(body.tasks[0].metadata.approvalRequired).toBe(true);
    expect(body.tasks[0].metadata.pendingAction).toBe('send_email');
  });

  it('returns empty array when no tasks are pending approval', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(fakeSpace);
    queueList({ value: [] });

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toEqual([]);
  });

  it('returns 500 when the Convex query fails', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(fakeSpace);
    queueList({ error: new Error('DB unavailable') });

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/failed to fetch/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/agent/approvals — approve action
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/agent/approvals — approve', () => {
  it('transitions paused task to queued on approval', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(fakeSpace);

    // Route fetches the task via getById (the ownership + status gate).
    queueGetById({ value: fakePausedTask });

    // Route writes via setStatusAndMetadata, which returns the updated row.
    const updatedTask = {
      ...fakePausedTask,
      status: 'queued',
      metadata: {
        ...fakePausedTask.metadata,
        approvedAt: '2026-05-06T10:00:00.000Z',
        approvedBy: USER_ID,
      },
    };
    queueUpdate({ value: updatedTask });

    const res = await POST(
      makePostRequest({ taskId: 'task-paused-001', action: 'approve' }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.status).toBe('queued');
    expect(body.task.metadata.approvedBy).toBe(USER_ID);
    expect(body.task.metadata.approvedAt).toBeTruthy();
    // The write must carry status=queued and stamp approvedBy in metadata.
    const [, mutArgs] = convexMutationMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(mutArgs).toMatchObject({ taskId: 'task-paused-001', status: 'queued' });
    expect((mutArgs.metadata as Record<string, unknown>).approvedBy).toBe(USER_ID);
  });

  it('returns 400 when taskId is missing', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(fakeSpace);

    const res = await POST(makePostRequest({ action: 'approve' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/taskId/i);
  });

  it('returns 400 when action is invalid', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(fakeSpace);

    const res = await POST(
      makePostRequest({ taskId: 'task-paused-001', action: 'invalidaction' }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/approve.*reject/i);
  });

  it('returns 404 when task does not exist', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(fakeSpace);

    // getById returns null → task not found
    queueGetById({ value: null });

    const res = await POST(
      makePostRequest({ taskId: 'task-nonexistent', action: 'approve' }),
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it('prevents approval of task belonging to a different space (403)', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    // User's space is different from the task's spaceId
    mockGetSpaceForUser.mockResolvedValue({ ...fakeSpace, id: 'space-other-999' } as never);

    // Task belongs to SPACE_ID, but the user's space is space-other-999
    queueGetById({ value: fakePausedTask });

    const res = await POST(
      makePostRequest({ taskId: 'task-paused-001', action: 'approve' }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('returns 409 when task is not in paused status', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(fakeSpace);

    // Task is already completed — not paused
    queueGetById({ value: { ...fakePausedTask, status: 'completed' } });

    const res = await POST(
      makePostRequest({ taskId: 'task-paused-001', action: 'approve' }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/not awaiting approval/i);
  });

  it('returns 500 when the Convex write fails during approval', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(fakeSpace);

    queueGetById({ value: fakePausedTask });           // gate read succeeds
    queueUpdate({ error: new Error('write conflict') }); // write throws → 500

    const res = await POST(
      makePostRequest({ taskId: 'task-paused-001', action: 'approve' }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/failed to update/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/agent/approvals — reject action
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/agent/approvals — reject', () => {
  it('transitions paused task to cancelled on rejection', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(fakeSpace);

    queueGetById({ value: fakePausedTask });

    const updatedTask = {
      ...fakePausedTask,
      status: 'cancelled',
      metadata: {
        ...fakePausedTask.metadata,
        rejectedAt: '2026-05-06T10:00:00.000Z',
        rejectedBy: USER_ID,
        rejectionReason: 'Too risky at this price',
      },
    };
    queueUpdate({ value: updatedTask });

    const res = await POST(
      makePostRequest({
        taskId: 'task-paused-001',
        action: 'reject',
        reason: 'Too risky at this price',
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.status).toBe('cancelled');
    expect(body.task.metadata.rejectedBy).toBe(USER_ID);
    expect(body.task.metadata.rejectedAt).toBeTruthy();
    expect(body.task.metadata.rejectionReason).toBe('Too risky at this price');
    // The write carries status=cancelled and the rejection reason in metadata.
    const [, mutArgs] = convexMutationMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(mutArgs).toMatchObject({ status: 'cancelled' });
    expect((mutArgs.metadata as Record<string, unknown>).rejectionReason).toBe('Too risky at this price');
  });

  it('rejection without a reason still succeeds (reason is optional)', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(fakeSpace);

    queueGetById({ value: fakePausedTask });

    const updatedTask = {
      ...fakePausedTask,
      status: 'cancelled',
      metadata: {
        ...fakePausedTask.metadata,
        rejectedAt: '2026-05-06T10:00:00.000Z',
        rejectedBy: USER_ID,
      },
    };
    queueUpdate({ value: updatedTask });

    const res = await POST(
      makePostRequest({ taskId: 'task-paused-001', action: 'reject' }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.status).toBe('cancelled');
    expect(body.task.metadata.rejectionReason).toBeUndefined();
    // No reason supplied → the write must NOT include rejectionReason.
    const [, mutArgs] = convexMutationMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect((mutArgs.metadata as Record<string, unknown>).rejectionReason).toBeUndefined();
  });

  it('prevents rejection of task belonging to a different space (403)', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue({ ...fakeSpace, id: 'space-other-999' } as never);

    // Task belongs to SPACE_ID; user's space is space-other-999
    queueGetById({ value: fakePausedTask });

    const res = await POST(
      makePostRequest({ taskId: 'task-paused-001', action: 'reject' }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const res = await POST(
      makePostRequest({ taskId: 'task-paused-001', action: 'reject' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when JSON body is malformed', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID });
    mockGetSpaceForUser.mockResolvedValue(fakeSpace);

    const req = new NextRequest('http://localhost/api/agent/approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json{{{',
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid json/i);
  });
});
