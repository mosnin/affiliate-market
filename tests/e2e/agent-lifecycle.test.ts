/**
 * E2E integration tests for the agent task lifecycle.
 *
 * Covers the full arc: enqueue → queued → running → completed/failed/retry.
 *
 * The AgentTask persistence layer moved from Supabase to Convex, so the state
 * machine now drives:
 *   - enqueueTask     → convex().mutation(api.agent.tasks.enqueue)   → new id
 *   - transitionTask  → convex().query(api.agent.tasks.getById)      → row|null
 *                       then (if the edge is valid) convex().mutation(
 *                       api.agent.tasks.transition, …)               → { ok, error? }
 *
 * Mock model — we sequence two Convex queues, branched by the dotted fn path:
 *   - the QUERY mock pulls the next AgentTask row (the getById status read).
 *     `queueTask({ status })` enqueues one; a missing row is `queueTask(null)`.
 *   - the MUTATION mock branches: `enqueue` pulls the next id from the enqueue
 *     queue; `transition` pulls the next { ok, error? } from the transition
 *     queue. The compare-and-swap that used to live in `.eq('status', current)`
 *     now lives in the `transition` mutation; an invalid edge is rejected by
 *     canTransition() in the lib BEFORE the mutation is reached, so for those
 *     cases the transition queue is never touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Convex queue-based mock ───────────────────────────────────────────────────

type TaskRow = { id?: string; status: TaskStatus } | null;
type TransitionResult = { ok: boolean; error?: string };

let taskQueue: TaskRow[] = [];          // answers getById (FIFO)
let enqueueQueue: string[] = [];        // answers enqueue (FIFO) → new task id
let transitionQueue: TransitionResult[] = []; // answers transition (FIFO)

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

// Import AFTER vi.mock so the module picks up the mock.
import {
  canTransition,
  transitionTask,
  enqueueTask,
  type TaskStatus,
} from '@/lib/agent/task-state-machine';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fnPath(ref: unknown): string {
  return typeof ref === 'function' ? (ref as () => string)() : '';
}

/** Queue the AgentTask row the next getById should return (or null). */
function queueTask(row: TaskRow) {
  taskQueue.push(row);
}
/** Queue the id the next enqueue mutation should return. */
function queueEnqueue(id: string) {
  enqueueQueue.push(id);
}
/** Queue the result the next transition mutation should return. */
function queueTransition(result: TransitionResult) {
  transitionQueue.push(result);
}

beforeEach(() => {
  vi.clearAllMocks();
  taskQueue = [];
  enqueueQueue = [];
  transitionQueue = [];

  convexQueryMock.mockImplementation(async () => {
    // The only query the state machine issues is getById.
    return taskQueue.length > 0 ? taskQueue.shift()! : null;
  });

  convexMutationMock.mockImplementation(async (ref: unknown) => {
    const path = fnPath(ref);
    if (path.includes('enqueue')) {
      if (enqueueQueue.length === 0) throw new Error('Failed to enqueue AgentTask');
      return enqueueQueue.shift()!;
    }
    if (path.includes('transition')) {
      return transitionQueue.length > 0
        ? transitionQueue.shift()!
        : { ok: false, error: 'invalid_transition' };
    }
    return null;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// canTransition — pure guard, no DB involved
// ─────────────────────────────────────────────────────────────────────────────

describe('canTransition()', () => {
  it('allows queued → running', () => {
    expect(canTransition('queued', 'running')).toBe(true);
  });

  it('allows running → completed', () => {
    expect(canTransition('running', 'completed')).toBe(true);
  });

  it('allows running → failed', () => {
    expect(canTransition('running', 'failed')).toBe(true);
  });

  it('allows running → paused', () => {
    expect(canTransition('running', 'paused')).toBe(true);
  });

  it('allows paused → running', () => {
    expect(canTransition('paused', 'running')).toBe(true);
  });

  it('allows failed → queued (retry path)', () => {
    expect(canTransition('failed', 'queued')).toBe(true);
  });

  it('blocks running → queued (no direct requeue while running)', () => {
    expect(canTransition('running', 'queued')).toBe(false);
  });

  it('blocks completed → running (terminal state)', () => {
    expect(canTransition('completed', 'running')).toBe(false);
  });

  it('blocks cancelled → running (terminal state)', () => {
    expect(canTransition('cancelled', 'running')).toBe(false);
  });

  it('blocks queued → completed (must pass through running)', () => {
    expect(canTransition('queued', 'completed')).toBe(false);
  });

  it('blocks paused → completed (must go through running)', () => {
    expect(canTransition('paused', 'completed')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enqueueTask() — writes to Convex (mocked)
// ─────────────────────────────────────────────────────────────────────────────

describe('enqueueTask()', () => {
  it('creates a task with status=queued and returns the new task id', async () => {
    queueEnqueue('task-enqueue-001');

    const id = await enqueueTask('space-xyz', {
      title: 'Follow up with Sam Chen',
      goalDescription: 'Call Sam to discuss the Maple St offer.',
      triggerSource: 'manual',
    });

    expect(id).toBe('task-enqueue-001');
    // The insert must carry status-defining inputs; status=queued is set inside
    // the Convex mutation. Verify the space + goal round-trip.
    const [, mutArgs] = convexMutationMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(mutArgs).toMatchObject({
      spaceId: 'space-xyz',
      title: 'Follow up with Sam Chen',
      goalDescription: 'Call Sam to discuss the Maple St offer.',
      triggerSource: 'manual',
    });
  });

  it('works with minimal input (title only)', async () => {
    queueEnqueue('task-min-001');

    const id = await enqueueTask('space-xyz', { title: 'Quick check-in' });

    expect(id).toBe('task-min-001');
  });

  it('throws when the enqueue mutation errors', async () => {
    convexMutationMock.mockRejectedValueOnce(new Error('unique constraint violation'));

    await expect(
      enqueueTask('space-xyz', { title: 'Duplicate task' }),
    ).rejects.toThrow();
  });

  it('throws with "Failed to enqueue AgentTask" when the mutation yields no id', async () => {
    // Nothing queued → the mutation mock throws the default message, which the
    // lib re-wraps verbatim.
    await expect(
      enqueueTask('space-xyz', { title: 'Ghost task' }),
    ).rejects.toThrow('Failed to enqueue AgentTask');
  });

  it('passes all optional fields through to the insert', async () => {
    queueEnqueue('task-full-001');

    const id = await enqueueTask('space-xyz', {
      title: 'Schedule open house',
      description: 'Coordinate with the listing agent',
      goalDescription: 'Book the open house for 123 Maple St',
      triggerSource: 'scheduled',
      totalSteps: 5,
    });

    expect(id).toBe('task-full-001');
    const [, mutArgs] = convexMutationMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(mutArgs).toMatchObject({
      title: 'Schedule open house',
      description: 'Coordinate with the listing agent',
      goalDescription: 'Book the open house for 123 Maple St',
      triggerSource: 'scheduled',
      totalSteps: 5,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// transitionTask() — reads then writes to Convex (mocked)
// ─────────────────────────────────────────────────────────────────────────────

describe('transitionTask()', () => {
  it('queued → running: returns { ok: true } and performs the transition mutation', async () => {
    queueTask({ status: 'queued' });        // getById
    queueTransition({ ok: true });          // transition CAS succeeds

    const result = await transitionTask('task-001', 'running');

    expect(result).toEqual({ ok: true });
    const [, mutArgs] = convexMutationMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(mutArgs).toMatchObject({ taskId: 'task-001', to: 'running', expectedFrom: 'queued' });
  });

  it('running → completed: returns { ok: true }', async () => {
    queueTask({ status: 'running' });
    queueTransition({ ok: true });

    const result = await transitionTask('task-002', 'completed', {
      completedAt: '2026-05-06T12:00:00.000Z',
    });

    expect(result).toEqual({ ok: true });
    const [, mutArgs] = convexMutationMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(mutArgs).toMatchObject({ completedAt: '2026-05-06T12:00:00.000Z' });
  });

  it('running → failed: returns { ok: true }', async () => {
    queueTask({ status: 'running' });
    queueTransition({ ok: true });

    const result = await transitionTask('task-003', 'failed');

    expect(result).toEqual({ ok: true });
  });

  it('running → paused: returns { ok: true } and parks the pausedReason', async () => {
    queueTask({ status: 'running' });
    queueTransition({ ok: true });

    const result = await transitionTask('task-004', 'paused', {
      pausedReason: 'awaiting approval',
    });

    expect(result).toEqual({ ok: true });
    const [, mutArgs] = convexMutationMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(mutArgs).toMatchObject({ pausedReason: 'awaiting approval' });
  });

  it('invalid transition (running → queued): returns { ok: false, error: "invalid_transition" } without calling the transition mutation', async () => {
    queueTask({ status: 'running' });

    const result = await transitionTask('task-005', 'queued');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_transition');
    // The CAS mutation must never run for an edge the guard already rejected.
    expect(convexMutationMock).not.toHaveBeenCalled();
    // The transition queue is untouched.
    expect(transitionQueue).toHaveLength(0);
  });

  it('invalid transition (completed → running): returns { ok: false, error: "invalid_transition" }', async () => {
    queueTask({ status: 'completed' });

    const result = await transitionTask('task-006', 'running');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_transition');
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('task not found (getById returns null): returns { ok: false, error: "not_found" }', async () => {
    queueTask(null);

    const result = await transitionTask('task-nonexistent', 'running');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('not_found');
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('lost CAS race (transition mutation reports invalid_transition): returns it without throwing', async () => {
    // canTransition passes, but the mutation's compare-and-swap finds the row
    // already moved underneath and reports the lost race.
    queueTask({ status: 'running' });
    queueTransition({ ok: false, error: 'invalid_transition' });

    const result = await transitionTask('task-006b', 'completed');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_transition');
  });

  it('transition mutation throws: returns { ok: false, error: <message> } without throwing', async () => {
    queueTask({ status: 'running' });
    convexMutationMock.mockRejectedValueOnce(new Error('connection timeout'));

    const result = await transitionTask('task-007', 'completed');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('connection timeout');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full lifecycle flows — multi-step sequences
// ─────────────────────────────────────────────────────────────────────────────

describe('Full lifecycle flows', () => {
  it('queued → running → completed: all transitions succeed in sequence', async () => {
    // Step 1: queued → running
    queueTask({ status: 'queued' });
    queueTransition({ ok: true });
    // Step 2: running → completed
    queueTask({ status: 'running' });
    queueTransition({ ok: true });

    const r1 = await transitionTask('task-flow-001', 'running', {
      startedAt: '2026-05-06T10:00:00.000Z',
    });
    expect(r1).toEqual({ ok: true });

    const r2 = await transitionTask('task-flow-001', 'completed', {
      completedAt: '2026-05-06T10:05:00.000Z',
    });
    expect(r2).toEqual({ ok: true });
  });

  it('running → failed → queued (retry): retry path succeeds', async () => {
    // Step 1: running → failed
    queueTask({ status: 'running' });
    queueTransition({ ok: true });
    // Step 2: failed → queued (retry)
    queueTask({ status: 'failed' });
    queueTransition({ ok: true });

    const r1 = await transitionTask('task-retry-001', 'failed');
    expect(r1).toEqual({ ok: true });

    const r2 = await transitionTask('task-retry-001', 'queued');
    expect(r2).toEqual({ ok: true });
  });

  it('enqueue then transition queued → running: combines insert + transition correctly', async () => {
    // Enqueue → returns id
    queueEnqueue('task-combo-001');
    // Transition queued → running: getById + transition
    queueTask({ status: 'queued' });
    queueTransition({ ok: true });

    const id = await enqueueTask('space-abc', { title: 'Send follow-up email' });
    expect(id).toBe('task-combo-001');

    const result = await transitionTask(id, 'running', {
      startedAt: new Date().toISOString(),
    });
    expect(result).toEqual({ ok: true });
  });

  it('task cost accumulation: multiple transitions succeed independently (no state bleed between calls)', async () => {
    // First full transition: queued → running
    queueTask({ status: 'queued' });
    queueTransition({ ok: true });
    // Second full transition: running → completed
    queueTask({ status: 'running' });
    queueTransition({ ok: true });

    const r1 = await transitionTask('task-cost-001', 'running', { startedAt: '2026-05-06T10:00:00.000Z' });
    const r2 = await transitionTask('task-cost-001', 'completed', { completedAt: '2026-05-06T10:10:00.000Z' });

    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    // Both queues fully consumed — no leftover state.
    expect(taskQueue).toHaveLength(0);
    expect(transitionQueue).toHaveLength(0);
  });
});
