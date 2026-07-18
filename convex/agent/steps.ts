import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ExecutionStep data access — the Convex replacement for the `.from('ExecutionStep')`
 * reads & writes in lib/agent/tool-call-logger.ts and the task-detail / admin-stats
 * routes.
 *
 * tool-call-logger logs are best-effort (the lib swallows failures); these
 * mutations mirror that — they no-op rather than throw if the step is gone.
 *
 * UNIQUE(idempotencyKey) exists on the table but no call site sets/reads it
 * today; the schema keeps `by_idempotency_key` so the invariant stays available.
 */

const stepStatusValidator = v.union(
  v.literal('pending'),
  v.literal('running'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('skipped'),
);

type StepFields = {
  id: string;
  taskId?: string;
  spaceId: string;
  stepIndex: number;
  toolName: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  idempotencyKey?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  stepType: string;
  inputSummary?: string;
  outputSummary?: string;
};

/** The full ExecutionStep row the task-detail page consumes (`select('*')`). */
function toStepRow(s: StepFields) {
  return {
    id: s.id,
    taskId: s.taskId ?? null,
    spaceId: s.spaceId,
    stepIndex: s.stepIndex,
    toolName: s.toolName,
    toolArgs: s.toolArgs ?? {},
    toolResult: s.toolResult ?? null,
    status: s.status,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    costUsd: s.costUsd,
    idempotencyKey: s.idempotencyKey ?? null,
    errorMessage: s.errorMessage ?? null,
    startedAt: s.startedAt ?? null,
    completedAt: s.completedAt ?? null,
    createdAt: s.createdAt,
    stepType: s.stepType,
    inputSummary: s.inputSummary ?? null,
    outputSummary: s.outputSummary ?? null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A task's steps ordered by stepIndex asc. Mirrors `.eq('taskId').order('stepIndex',
 *  asc)`. (The cola task-detail variant orders by startedAt asc — pass
 *  orderBy:'startedAt' for that.) */
export const listByTask = query({
  args: { taskId: v.string(), orderBy: v.optional(v.union(v.literal('stepIndex'), v.literal('startedAt'))) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ExecutionStep')
      .withIndex('by_task_step', (q) => q.eq('taskId', args.taskId))
      .collect();
    if (args.orderBy === 'startedAt') {
      rows.sort((a, b) => {
        const av = a.startedAt ?? '';
        const bv = b.startedAt ?? '';
        return av < bv ? -1 : av > bv ? 1 : 0;
      });
    } else {
      rows.sort((a, b) => a.stepIndex - b.stepIndex);
    }
    return rows.map(toStepRow);
  },
});

/**
 * Admin-stats "top tools": every step's toolName where the step's PARENT
 * AgentTask was created since `since`. Replaces the PostgREST inner-join
 * `.select('toolName, AgentTask!inner(createdAt)').gte('AgentTask.createdAt', since)`.
 * Both tables are this domain's, so the join runs inside one query: collect the
 * recent task ids, then return toolNames for steps on those tasks. The lib folds
 * the toolName list into per-tool counts (the tally stays in the unit-tested lib).
 */
export const toolNamesForTasksSince = query({
  args: { since: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const tasks = await ctx.db
      .query('AgentTask')
      .withIndex('by_created', (q) => q.gte('createdAt', args.since))
      .collect();
    const taskIds = new Set(tasks.map((t) => t.id));
    if (taskIds.size === 0) return [];
    // One indexed read per recent task, concatenating toolNames.
    const out: string[] = [];
    for (const tid of taskIds) {
      const steps = await ctx.db
        .query('ExecutionStep')
        .withIndex('by_task_step', (q) => q.eq('taskId', tid))
        .collect();
      for (const s of steps) out.push(s.toolName);
    }
    return out;
  },
});

// ── Writes (tool-call logger; best-effort) ────────────────────────────────────

/** Insert a 'running' step at the start of a tool call. Mirrors
 *  logToolCallStart's insert (id minted by the lib today; we accept it so the
 *  returned stepId the lib hands to logToolCallComplete/Error stays stable, but
 *  default to a fresh uuid if omitted). taskId is optional (chat-turn tool calls
 *  have no task). */
export const logStart = mutation({
  args: {
    id: v.optional(v.string()),
    spaceId: v.string(),
    taskId: v.union(v.string(), v.null()),
    toolName: v.string(),
    inputSummary: v.optional(v.string()),
    stepIndex: v.optional(v.number()),
    stepType: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string> => {
    const id = args.id ?? crypto.randomUUID();
    await ctx.db.insert('ExecutionStep', {
      id,
      spaceId: args.spaceId,
      // Task-less chat-turn tool calls keep taskId absent (the schema makes it
      // optional — see the schema note; PG's NOT NULL made this insert fail).
      ...(args.taskId !== null ? { taskId: args.taskId } : {}),
      stepIndex: args.stepIndex ?? 0,
      stepType: args.stepType ?? 'tool_call',
      toolName: args.toolName,
      toolArgs: {},
      ...(args.inputSummary !== undefined ? { inputSummary: args.inputSummary } : {}),
      status: 'running',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      startedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    return id;
  },
});

/** Patch a step to 'completed' with output summary + result. Mirrors
 *  logToolCallComplete. No-op if the step is gone (best-effort, matches the lib's
 *  swallow-failure posture). */
export const logComplete = mutation({
  args: { stepId: v.string(), outputSummary: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const s = await ctx.db
      .query('ExecutionStep')
      .withIndex('by_app_id', (q) => q.eq('id', args.stepId))
      .unique();
    if (!s) return;
    await ctx.db.patch(s._id, {
      outputSummary: args.outputSummary,
      toolResult: { output: args.outputSummary },
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
  },
});

/** Patch a step to 'failed' with an error message. Mirrors logToolCallError.
 *  No-op if the step is gone. */
export const logError = mutation({
  args: { stepId: v.string(), errorMessage: v.string(), outputSummary: v.optional(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    const s = await ctx.db
      .query('ExecutionStep')
      .withIndex('by_app_id', (q) => q.eq('id', args.stepId))
      .unique();
    if (!s) return;
    await ctx.db.patch(s._id, {
      errorMessage: args.errorMessage,
      ...(args.outputSummary !== undefined ? { outputSummary: args.outputSummary } : {}),
      status: 'failed',
      completedAt: new Date().toISOString(),
    });
  },
});

// statusStepValidator exported for callers that need to type a status arg.
export { stepStatusValidator };
