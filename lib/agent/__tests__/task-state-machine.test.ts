/**
 * Integration tests for lib/agent/task-state-machine.ts
 *
 * canTransition() is a pure guard — no mocking needed.
 * transitionTask() and enqueueTask() now write to Convex (the AgentTask
 * persistence layer moved off Supabase). They call:
 *   - convex().query(api.agent.tasks.getById, { id })        → row | null
 *   - convex().mutation(api.agent.tasks.transition, …)       → { ok, error? }
 *   - convex().mutation(api.agent.tasks.enqueue, …)          → new task id
 *
 * The compare-and-swap that used to live in `.update().eq('status', current)`
 * now lives in the `transition` mutation: it returns { ok:false,
 * error:'invalid_transition' } when the row's status no longer equals
 * expectedFrom (lost race), and { ok:false, error:'not_found' } when the row
 * is gone. The lib already validates canTransition() BEFORE calling the
 * mutation, so an invalid edge never reaches the mutation — the lib short-
 * circuits and the mutation is not called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Convex mock ─────────────────────────────────────────────────────────────
//
// `api` is a path proxy: api.agent.tasks.getById stringifies to its dotted
// path when called, so the mocks can branch on the fn the lib invoked. The
// query mock answers the getById status read; the mutation mock answers both
// `transition` (the CAS) and `enqueue` (the insert), branched on the path.

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

// Import AFTER vi.mock so the module picks up the mock
import {
  canTransition,
  transitionTask,
  enqueueTask,
  type TaskStatus,
} from '@/lib/agent/task-state-machine';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve the dotted fn path from a path-proxy ref. */
function fnPath(ref: unknown): string {
  return typeof ref === 'function' ? (ref as () => string)() : '';
}

beforeEach(() => {
  convexQueryMock.mockReset();
  convexMutationMock.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// canTransition — pure function, no mocking needed
// ─────────────────────────────────────────────────────────────────────────────

describe('canTransition()', () => {
  it('queued → running: true', () => {
    expect(canTransition('queued', 'running')).toBe(true);
  });

  it('queued → completed: false', () => {
    expect(canTransition('queued', 'completed')).toBe(false);
  });

  it('running → paused: true', () => {
    expect(canTransition('running', 'paused')).toBe(true);
  });

  it('running → completed: true', () => {
    expect(canTransition('running', 'completed')).toBe(true);
  });

  it('running → failed: true', () => {
    expect(canTransition('running', 'failed')).toBe(true);
  });

  it('running → cancelled: true', () => {
    expect(canTransition('running', 'cancelled')).toBe(true);
  });

  it('paused → running: true', () => {
    expect(canTransition('paused', 'running')).toBe(true);
  });

  it('paused → completed: false (must go through running)', () => {
    expect(canTransition('paused', 'completed')).toBe(false);
  });

  it('completed → running: false (terminal state)', () => {
    expect(canTransition('completed', 'running')).toBe(false);
  });

  it('failed → queued: true (retry path)', () => {
    expect(canTransition('failed', 'queued')).toBe(true);
  });

  it('cancelled → running: false (terminal state)', () => {
    expect(canTransition('cancelled', 'running')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// transitionTask() — mocked Convex
// ─────────────────────────────────────────────────────────────────────────────

describe('transitionTask()', () => {
  it('valid transition: getById returns running, transition mutation succeeds, returns { ok: true }', async () => {
    convexQueryMock.mockResolvedValue({ id: 'task-001', status: 'running' as TaskStatus });
    convexMutationMock.mockResolvedValue({ ok: true });

    const result = await transitionTask('task-001', 'completed');

    expect(result).toEqual({ ok: true });
    // The transition mutation must carry the CAS guard (expectedFrom = current).
    expect(convexMutationMock).toHaveBeenCalledTimes(1);
    const [, mutArgs] = convexMutationMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(mutArgs).toMatchObject({ taskId: 'task-001', to: 'completed', expectedFrom: 'running' });
  });

  it('invalid transition: getById happens but the transition mutation is NOT called, returns { ok: false }', async () => {
    // Current status is 'completed' — terminal, cannot go to 'running'. The lib
    // short-circuits on canTransition() before ever hitting the mutation.
    convexQueryMock.mockResolvedValue({ id: 'task-002', status: 'completed' as TaskStatus });

    const result = await transitionTask('task-002', 'running');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_transition');
    // The CAS mutation must never run for an edge the guard already rejected.
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('lost CAS race: the transition mutation reports invalid_transition (status moved underneath), returns it', async () => {
    // canTransition passes (running → completed), but the mutation's compare-
    // and-swap finds the row already moved and reports the lost race.
    convexQueryMock.mockResolvedValue({ id: 'task-003', status: 'running' as TaskStatus });
    convexMutationMock.mockResolvedValue({ ok: false, error: 'invalid_transition' });

    const result = await transitionTask('task-003', 'completed');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_transition');
  });

  it('mutation throws: returns { ok: false, error: <message> } and never throws', async () => {
    convexQueryMock.mockResolvedValue({ id: 'task-004', status: 'running' as TaskStatus });
    convexMutationMock.mockRejectedValue(new Error('connection timeout'));

    const result = await transitionTask('task-004', 'completed');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('connection timeout');
  });

  it('task not found (getById returns null): returns { ok: false, error: "not_found" }', async () => {
    convexQueryMock.mockResolvedValue(null);

    const result = await transitionTask('task-nonexistent', 'running');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('not_found');
    // No mutation attempted for a task that doesn't exist.
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('passes metadata fields (completedAt) through to the transition mutation', async () => {
    convexQueryMock.mockResolvedValue({ id: 'task-005', status: 'running' as TaskStatus });
    convexMutationMock.mockResolvedValue({ ok: true });

    const meta = {
      completedAt: '2026-05-06T12:00:00.000Z',
    };
    const result = await transitionTask('task-005', 'completed', meta);

    expect(result).toEqual({ ok: true });
    const [, mutArgs] = convexMutationMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(mutArgs).toMatchObject({ completedAt: '2026-05-06T12:00:00.000Z' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enqueueTask() — mocked Convex
// ─────────────────────────────────────────────────────────────────────────────

describe('enqueueTask()', () => {
  it('success: inserts row with status queued, returns the new task id', async () => {
    convexMutationMock.mockImplementation(async (ref: unknown) => {
      if (fnPath(ref).includes('enqueue')) return 'new-task-xyz';
      return null;
    });

    const id = await enqueueTask('space-abc', {
      title: 'Follow up with Sam Chen',
      goalDescription: 'Call Sam to discuss the Maple St offer.',
      triggerSource: 'manual',
    });

    expect(id).toBe('new-task-xyz');
  });

  it('success with minimal input (title only): returns id', async () => {
    convexMutationMock.mockResolvedValue('task-min-001');

    const id = await enqueueTask('space-abc', { title: 'Quick check-in' });

    expect(id).toBe('task-min-001');
  });

  it('Convex error: throws with an error message', async () => {
    convexMutationMock.mockRejectedValue(new Error('unique constraint violation'));

    await expect(
      enqueueTask('space-abc', { title: 'Duplicate task' }),
    ).rejects.toThrow();
  });

  it('non-Error rejection: throws the default "Failed to enqueue AgentTask" message', async () => {
    // The Convex insert always returns an id on success; the only "no id" path
    // is a thrown non-Error, which the lib wraps in its default message.
    convexMutationMock.mockRejectedValue('opaque failure');

    await expect(
      enqueueTask('space-abc', { title: 'Ghost task' }),
    ).rejects.toThrow('Failed to enqueue AgentTask');
  });
});
