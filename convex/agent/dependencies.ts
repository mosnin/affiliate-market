import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * TaskDependency data access. NO call sites exist in the codebase today (written/
 * read by the Python agent worker), but the schema carries it for completeness
 * and the AgentTask cascade-delete drops a task's dependency edges on BOTH sides.
 * Minimal CRUD for a future caller / worker port.
 *
 * Two Postgres CHECKs preserved in `create`:
 *   - CHECK(taskId <> dependsOnTaskId): a task can't depend on itself (rejected).
 *   - UNIQUE(taskId, dependsOnTaskId): one edge per pair — read-before-insert
 *     backstop (the old unique index), serializable inside the mutation.
 */

const dependencyTypeValidator = v.union(
  v.literal('sequential'),
  v.literal('data'),
  v.literal('soft'),
);

function toRow(d: Doc<'TaskDependency'>) {
  return {
    id: d.id,
    taskId: d.taskId,
    dependsOnTaskId: d.dependsOnTaskId,
    dependencyType: d.dependencyType,
    createdAt: d.createdAt,
  };
}

/** A task's outgoing dependency edges (TaskDependency_taskId_idx). */
export const listForTask = query({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('TaskDependency')
      .withIndex('by_task', (q) => q.eq('taskId', args.taskId))
      .collect();
    return rows.map(toRow);
  },
});

/** Edges that point AT a task (TaskDependency_dependsOnTaskId_idx) — its
 *  dependents. */
export const listDependents = query({
  args: { dependsOnTaskId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('TaskDependency')
      .withIndex('by_depends_on', (q) => q.eq('dependsOnTaskId', args.dependsOnTaskId))
      .collect();
    return rows.map(toRow);
  },
});

export interface CreateDepResult {
  ok: boolean;
  /** 'self' = taskId == dependsOnTaskId (CHECK violation); 'duplicate' = edge
   *  already exists (UNIQUE violation). */
  error?: 'self' | 'duplicate';
  dependency: ReturnType<typeof toRow> | null;
}

/** Insert a dependency edge, enforcing the self-edge CHECK and the
 *  (taskId, dependsOnTaskId) UNIQUE via read-before-insert. dependencyType
 *  defaults to 'sequential'. */
export const create = mutation({
  args: {
    taskId: v.string(),
    dependsOnTaskId: v.string(),
    dependencyType: v.optional(dependencyTypeValidator),
  },
  handler: async (ctx, args): Promise<CreateDepResult> => {
    if (args.taskId === args.dependsOnTaskId) {
      return { ok: false, error: 'self', dependency: null };
    }
    // UNIQUE(taskId, dependsOnTaskId) backstop.
    const existing = await ctx.db
      .query('TaskDependency')
      .withIndex('by_task', (q) =>
        q.eq('taskId', args.taskId).eq('dependsOnTaskId', args.dependsOnTaskId),
      )
      .first();
    if (existing) return { ok: false, error: 'duplicate', dependency: toRow(existing) };

    const doc = {
      id: crypto.randomUUID(),
      taskId: args.taskId,
      dependsOnTaskId: args.dependsOnTaskId,
      dependencyType: args.dependencyType ?? ('sequential' as const),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('TaskDependency', doc);
    return { ok: true, dependency: toRow(doc as Doc<'TaskDependency'>) };
  },
});

/** Delete an edge by id. */
export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const d = await ctx.db
      .query('TaskDependency')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d) return { ok: false };
    await ctx.db.delete(d._id);
    return { ok: true };
  },
});
