import { convex, api } from '@/lib/convex-server';

// ── Status types ──────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

// ── Valid state transitions ───────────────────────────────────────────────────

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued:    ['running', 'cancelled'],
  running:   ['paused', 'completed', 'failed', 'cancelled'],
  paused:    ['running', 'cancelled'],
  completed: [],
  failed:    ['queued'],   // allows retry
  cancelled: [],
};

// ── Guard ─────────────────────────────────────────────────────────────────────

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Transition ────────────────────────────────────────────────────────────────

/**
 * Reads the current task status, validates the requested transition, then
 * writes the new status (plus any timestamp/metadata fields) to AgentTask.
 *
 * Never throws — callers in API routes can pattern-match on `ok`.
 */
export async function transitionTask(
  taskId: string,
  to: TaskStatus,
  meta?: {
    cancelledAt?: string;
    completedAt?: string;
    startedAt?: string;
    pausedReason?: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  // 1. Read current status.
  const task = await convex().query(api.agent.tasks.getById, { id: taskId });

  if (!task) {
    return { ok: false, error: 'not_found' };
  }

  const current = task.status as TaskStatus;

  // 2. Validate transition.
  if (!canTransition(current, to)) {
    return { ok: false, error: 'invalid_transition' };
  }

  // 3. Apply the transition with a compare-and-swap on `current`. If a
  // concurrent transition already moved the task, the CAS fails and reports
  // the lost race (invalid_transition) instead of overwriting it. The
  // pausedReason -> metadata parking happens inside the mutation.
  try {
    const result = await convex().mutation(api.agent.tasks.transition, {
      taskId,
      to,
      expectedFrom: current,
      ...(meta?.startedAt !== undefined ? { startedAt: meta.startedAt } : {}),
      ...(meta?.completedAt !== undefined ? { completedAt: meta.completedAt } : {}),
      ...(meta?.cancelledAt !== undefined ? { cancelledAt: meta.cancelledAt } : {}),
      ...(meta?.pausedReason !== undefined ? { pausedReason: meta.pausedReason } : {}),
    });
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'invalid_transition' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'transition_failed' };
  }
}

// ── Enqueue ───────────────────────────────────────────────────────────────────

/**
 * Inserts a new AgentTask with status 'queued' and returns its id.
 * Throws on DB error — callers handle it.
 */
export async function enqueueTask(
  spaceId: string,
  input: {
    title: string;
    description?: string;
    triggerSource?: string;
    goalDescription?: string;
    parentTaskId?: string;
    totalSteps?: number;
  },
): Promise<string> {
  try {
    return await convex().mutation(api.agent.tasks.enqueue, {
      spaceId,
      title:           input.title,
      description:     input.description     ?? null,
      ...(input.triggerSource !== undefined ? { triggerSource: input.triggerSource } : {}),
      goalDescription: input.goalDescription ?? null,
      parentTaskId:    input.parentTaskId    ?? null,
      ...(input.totalSteps !== undefined ? { totalSteps: input.totalSteps } : {}),
    });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'Failed to enqueue AgentTask');
  }
}
