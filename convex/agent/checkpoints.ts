import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * TaskCheckpoint data access. NO call sites exist in the codebase today (written/
 * read by the Python agent worker), but the schema carries it for completeness
 * and the AgentTask cascade-delete drops a task's checkpoints. Minimal CRUD
 * mirroring the column shape for a future caller / worker port.
 */

function toRow(c: Doc<'TaskCheckpoint'>) {
  return {
    id: c.id,
    taskId: c.taskId,
    spaceId: c.spaceId,
    checkpointData: c.checkpointData,
    stepIndex: c.stepIndex,
    createdAt: c.createdAt,
  };
}

/** A task's checkpoints (TaskCheckpoint_taskId_idx), newest-first. */
export const listForTask = query({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('TaskCheckpoint')
      .withIndex('by_task', (q) => q.eq('taskId', args.taskId))
      .collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.map(toRow);
  },
});

/** The latest checkpoint for a task (highest stepIndex, then newest), or null —
 *  the natural "resume from here" read. */
export const latestForTask = query({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('TaskCheckpoint')
      .withIndex('by_task', (q) => q.eq('taskId', args.taskId))
      .collect();
    if (rows.length === 0) return null;
    rows.sort((a, b) => {
      if (b.stepIndex !== a.stepIndex) return b.stepIndex - a.stepIndex;
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    });
    return toRow(rows[0]);
  },
});

/** Insert a checkpoint. checkpointData is required (NOT NULL in PG); stepIndex
 *  defaults to 0. */
export const create = mutation({
  args: {
    taskId: v.string(),
    spaceId: v.string(),
    checkpointData: v.any(),
    stepIndex: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: crypto.randomUUID(),
      taskId: args.taskId,
      spaceId: args.spaceId,
      checkpointData: args.checkpointData,
      stepIndex: args.stepIndex ?? 0,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('TaskCheckpoint', doc);
    return toRow(doc as Doc<'TaskCheckpoint'>);
  },
});
