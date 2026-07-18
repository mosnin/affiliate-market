import { query, mutation, type MutationCtx } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * AgentTask data access — the Convex replacement for the `.from('AgentTask')`
 * reads & writes in lib/agent/task-state-machine.ts and the app/api/agent/tasks
 * + app/api/ai/task + admin-stats routes.
 *
 * STATE MACHINE: the VALID_TRANSITIONS guard stays in lib/agent/task-state-machine
 * (pure logic). The compare-and-swap that enforced it against a concurrent
 * transition is preserved here as `transition`: read current status, the caller
 * has already validated the edge, and the patch only lands if the status is still
 * what the caller read (read-then-patch inside one serializable mutation — this
 * is strictly stronger than the old `.update().eq('status', current)` CAS).
 *
 * CASCADE: Postgres ON DELETE CASCADE from AgentTask -> ExecutionStep /
 * GoalDecomposition / TaskCheckpoint / TaskDependency(taskId & dependsOnTaskId),
 * and ON DELETE SET NULL for child AgentTask.parentTaskId, are re-implemented in
 * `remove` (and in the cleanup mutation in convex/agent/cleanup.ts). Cross-domain
 * SET NULLs (AgentMemory.taskId, Artifact.taskId, Artifact.stepId) are NOT this
 * domain's tables and are flagged in the report — the integrator clears them.
 */

const taskStatusValidator = v.union(
  v.literal('queued'),
  v.literal('running'),
  v.literal('paused'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('cancelled'),
);

type TaskFields = {
  id: string;
  spaceId: string;
  title: string;
  description?: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  triggerSource: string;
  goalDescription?: string;
  parentTaskId?: string;
  totalSteps: number;
  completedSteps: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  metadata?: unknown;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
};

/** The full AgentTask row the call sites consume (`select('*')`). Surface `id`,
 *  coerce absent optionals to SQL NULL so the old Row shape is preserved. */
function toTaskRow(t: TaskFields) {
  return {
    id: t.id,
    spaceId: t.spaceId,
    title: t.title,
    description: t.description ?? null,
    status: t.status,
    triggerSource: t.triggerSource,
    goalDescription: t.goalDescription ?? null,
    parentTaskId: t.parentTaskId ?? null,
    totalSteps: t.totalSteps,
    completedSteps: t.completedSteps,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    estimatedCostUsd: t.estimatedCostUsd,
    metadata: t.metadata ?? {},
    startedAt: t.startedAt ?? null,
    completedAt: t.completedAt ?? null,
    cancelledAt: t.cancelledAt ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One task by id (no scope), or null. Used by the state-machine status read. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query('AgentTask')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return t ? toTaskRow(t) : null;
  },
});

/** One task by (id, spaceId) — the space-scoped lookup the task detail page,
 *  status PATCH and DELETE guard use. Returns null if the id isn't in the space. */
export const getByIdForSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query('AgentTask')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!t || t.spaceId !== args.spaceId) return null;
    return toTaskRow(t);
  },
});

/** A space's tasks newest-first (cap 50). Mirrors `.eq('spaceId').order('createdAt',
 *  desc).limit(50)`. */
export const listBySpace = query({
  args: { spaceId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentTask')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .take(args.limit ?? 50);
    return rows.map(toTaskRow);
  },
});

/** A space's PAUSED tasks that carry metadata.approvalRequired, newest-first
 *  (cap 50). Mirrors `.eq('spaceId').eq('status','paused').not('metadata->approvalRequired',
 *  'is', null).order('createdAt', desc).limit(50)` (the approvals/inbox views).
 *  The JSON-path filter is applied in-handler after the (spaceId,status) range. */
export const listPendingApprovals = query({
  args: { spaceId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentTask')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', 'paused'))
      .collect();
    const withApproval = rows.filter((t) => {
      const md = t.metadata as Record<string, unknown> | null | undefined;
      return md != null && md.approvalRequired != null;
    });
    withApproval.sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
    return withApproval.slice(0, args.limit ?? 50).map(toTaskRow);
  },
});

/** All tasks created since `since` (ISO), across all spaces — the admin-stats
 *  scan. Returns the minimal columns admin-stats folds (status, estimatedCostUsd,
 *  spaceId). Mirrors `.select('...').gte('createdAt', since)`. */
export const listSince = query({
  args: { since: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentTask')
      .withIndex('by_created', (q) => q.gte('createdAt', args.since))
      .collect();
    return rows.map((t) => ({
      id: t.id,
      spaceId: t.spaceId,
      status: t.status,
      estimatedCostUsd: t.estimatedCostUsd,
      createdAt: t.createdAt,
    }));
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/** Enqueue a new task (status 'queued'). Mirrors lib/agent/task-state-machine
 *  enqueueTask: PG defaulted triggerSource='manual', the int counts to 0, etc.
 *  Returns the new task's id (the lib returns `data.id`). */
export const enqueue = mutation({
  args: {
    spaceId: v.string(),
    title: v.string(),
    description: v.union(v.string(), v.null()),
    triggerSource: v.optional(v.string()),
    goalDescription: v.union(v.string(), v.null()),
    parentTaskId: v.union(v.string(), v.null()),
    totalSteps: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<string> => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await ctx.db.insert('AgentTask', {
      id,
      spaceId: args.spaceId,
      title: args.title,
      ...(args.description !== null ? { description: args.description } : {}),
      status: 'queued',
      triggerSource: args.triggerSource ?? 'manual',
      ...(args.goalDescription !== null ? { goalDescription: args.goalDescription } : {}),
      ...(args.parentTaskId !== null ? { parentTaskId: args.parentTaskId } : {}),
      totalSteps: args.totalSteps ?? 0,
      completedSteps: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    return id;
  },
});

export interface TransitionResult {
  ok: boolean;
  /** 'not_found' | 'invalid_transition' — mirrors transitionTask's error codes.
   *  invalid_transition also covers the lost-CAS case (status moved underneath us). */
  error?: 'not_found' | 'invalid_transition';
}

/**
 * Apply a validated status transition with a compare-and-swap on `expectedFrom`.
 * The caller (lib/agent/task-state-machine) has already checked canTransition;
 * this enforces the same anti-race the old `.eq('status', current)` did: if the
 * task's status no longer equals `expectedFrom` we report invalid_transition
 * instead of clobbering a concurrent move. Patches status + updatedAt, and any of
 * startedAt/completedAt/cancelledAt; pausedReason (no column) is parked in
 * metadata exactly as the lib did.
 */
export const transition = mutation({
  args: {
    taskId: v.string(),
    to: taskStatusValidator,
    expectedFrom: taskStatusValidator,
    startedAt: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    cancelledAt: v.optional(v.string()),
    pausedReason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<TransitionResult> => {
    const t = await ctx.db
      .query('AgentTask')
      .withIndex('by_app_id', (q) => q.eq('id', args.taskId))
      .unique();
    if (!t) return { ok: false, error: 'not_found' };
    // CAS: the status must still be what the caller validated against.
    if (t.status !== args.expectedFrom) return { ok: false, error: 'invalid_transition' };

    const patch: Record<string, unknown> = {
      status: args.to,
      updatedAt: new Date().toISOString(),
    };
    if (args.startedAt !== undefined) patch.startedAt = args.startedAt;
    if (args.completedAt !== undefined) patch.completedAt = args.completedAt;
    if (args.cancelledAt !== undefined) patch.cancelledAt = args.cancelledAt;
    if (args.pausedReason !== undefined) patch.metadata = { pausedReason: args.pausedReason };

    await ctx.db.patch(t._id, patch);
    return { ok: true };
  },
});

/**
 * Set a task's status + metadata directly (the approvals route's approve/reject
 * patch: `.update({ status, metadata, updatedAt }).eq('id', taskId)`). No CAS —
 * matches the old unconditional update. Returns the updated row (the route did
 * `.select('*').single()`), or null if the task vanished.
 */
export const setStatusAndMetadata = mutation({
  args: {
    taskId: v.string(),
    status: taskStatusValidator,
    metadata: v.any(),
  },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query('AgentTask')
      .withIndex('by_app_id', (q) => q.eq('id', args.taskId))
      .unique();
    if (!t) return null;
    await ctx.db.patch(t._id, {
      status: args.status,
      metadata: args.metadata,
      updatedAt: new Date().toISOString(),
    });
    const updated = (await ctx.db.get(t._id))!;
    return toTaskRow(updated);
  },
});

export interface RemoveResult {
  /** false = the task wasn't in the space (or didn't exist). */
  ok: boolean;
  /** Counts of cascaded child deletes (for the route's response/telemetry). */
  deletedSteps: number;
  deletedCheckpoints: number;
  deletedDependencies: number;
  deletedDecompositions: number;
  /** Children whose parentTaskId we nulled (ON DELETE SET NULL). */
  detachedChildren: number;
}

/**
 * Delete a task and re-implement every Postgres cascade the DB used to run:
 *   - CASCADE: ExecutionStep, GoalDecomposition, TaskCheckpoint, and
 *     TaskDependency rows on EITHER side (taskId or dependsOnTaskId) are deleted.
 *   - SET NULL: child AgentTask rows (parentTaskId == this id) keep existing with
 *     parentTaskId cleared.
 * Scoped to (id, spaceId) like the DELETE route's pre-check. Cross-domain
 * SET NULLs (AgentMemory.taskId, Artifact.taskId/stepId) are NOT touched here —
 * those tables live in other domains; flagged in the report for the integrator.
 */
export const remove = mutation({
  args: { taskId: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<RemoveResult> => {
    const t = await ctx.db
      .query('AgentTask')
      .withIndex('by_app_id', (q) => q.eq('id', args.taskId))
      .unique();
    if (!t || t.spaceId !== args.spaceId) {
      return {
        ok: false,
        deletedSteps: 0,
        deletedCheckpoints: 0,
        deletedDependencies: 0,
        deletedDecompositions: 0,
        detachedChildren: 0,
      };
    }
    return await cascadeDeleteTask(ctx, t);
  },
});

/** Shared cascade used by `remove` and the cleanup mutation. Deletes the task's
 *  CASCADE children and SET-NULLs its child tasks; returns the per-table counts. */
export async function cascadeDeleteTask(
  ctx: MutationCtx,
  task: Doc<'AgentTask'>,
): Promise<RemoveResult> {
  const taskId = task.id;

  // ExecutionStep (taskId CASCADE).
  const steps = await ctx.db
    .query('ExecutionStep')
    .withIndex('by_task_step', (q) => q.eq('taskId', taskId))
    .collect();
  for (const s of steps) await ctx.db.delete(s._id);

  // TaskCheckpoint (taskId CASCADE).
  const checkpoints = await ctx.db
    .query('TaskCheckpoint')
    .withIndex('by_task', (q) => q.eq('taskId', taskId))
    .collect();
  for (const c of checkpoints) await ctx.db.delete(c._id);

  // GoalDecomposition (taskId CASCADE).
  const decomps = await ctx.db
    .query('GoalDecomposition')
    .withIndex('by_task', (q) => q.eq('taskId', taskId))
    .collect();
  for (const d of decomps) await ctx.db.delete(d._id);

  // TaskDependency on EITHER side (both FKs CASCADE).
  const depsOut = await ctx.db
    .query('TaskDependency')
    .withIndex('by_task', (q) => q.eq('taskId', taskId))
    .collect();
  const depsIn = await ctx.db
    .query('TaskDependency')
    .withIndex('by_depends_on', (q) => q.eq('dependsOnTaskId', taskId))
    .collect();
  const depIds = new Set<string>();
  for (const d of [...depsOut, ...depsIn]) {
    if (depIds.has(d.id)) continue;
    depIds.add(d.id);
    await ctx.db.delete(d._id);
  }

  // Child tasks: parentTaskId SET NULL (they survive).
  const children = await ctx.db
    .query('AgentTask')
    .withIndex('by_parent', (q) => q.eq('parentTaskId', taskId))
    .collect();
  for (const child of children) {
    await ctx.db.patch(child._id, { parentTaskId: undefined, updatedAt: new Date().toISOString() });
  }

  // Finally the task itself.
  await ctx.db.delete(task._id);

  return {
    ok: true,
    deletedSteps: steps.length,
    deletedCheckpoints: checkpoints.length,
    deletedDecompositions: decomps.length,
    deletedDependencies: depIds.size,
    detachedChildren: children.length,
  };
}
