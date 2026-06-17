import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * GoalDecomposition data access.
 *
 * NO CURRENT CALL SITES: `grep -rnE "\.from\('GoalDecomposition'\)" lib app
 * components` returns nothing — no code reads or writes this table today. It was
 * a planner-output cache (the LLM goal→steps breakdown). This module is carried
 * for schema completeness and so the surface is ready the moment a caller lands;
 * a minimal CRUD set, matching the conventions of the rest of the domain.
 *
 * CASCADE: the AgentTask delete already clears a task's decompositions directly
 * (convex/agent/tasks.ts cascadeDeleteTask reads by_task and deletes) — that path
 * does NOT route through this module, so there is no cross-file coupling to keep
 * in sync. `removeForTask` here is the standalone equivalent for any future caller
 * that needs it.
 */

function toDecompositionRow(d: Doc<'GoalDecomposition'>) {
  return {
    id: d.id,
    spaceId: d.spaceId,
    taskId: d.taskId ?? null,
    goalText: d.goalText,
    decomposedSteps: d.decomposedSteps ?? [],
    llmModel: d.llmModel,
    promptTokens: d.promptTokens,
    completionTokens: d.completionTokens,
    createdAt: d.createdAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One decomposition by id, or null. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('GoalDecomposition')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return d ? toDecompositionRow(d) : null;
  },
});

/** A task's decompositions (by_task), newest-first. */
export const listByTask = query({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('GoalDecomposition')
      .withIndex('by_task', (q) => q.eq('taskId', args.taskId))
      .collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.map(toDecompositionRow);
  },
});

/** Decompositions scoped to a (spaceId, taskId) — the GoalDecomposition_spaceId_taskId_idx
 *  access pattern — newest-first. */
export const listForSpaceTask = query({
  args: { spaceId: v.string(), taskId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('GoalDecomposition')
      .withIndex('by_space_task', (q) => q.eq('spaceId', args.spaceId).eq('taskId', args.taskId))
      .collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.map(toDecompositionRow);
  },
});

// ── Writes ────────────────────────────────────────────────────────────────────

/** Insert a decomposition. PG defaults: decomposedSteps=[], llmModel='gpt-4.1-mini',
 *  promptTokens/completionTokens=0. taskId is nullable. Returns the new row. */
export const create = mutation({
  args: {
    spaceId: v.string(),
    taskId: v.union(v.string(), v.null()),
    goalText: v.string(),
    decomposedSteps: v.optional(v.any()),
    llmModel: v.optional(v.string()),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      ...(args.taskId !== null ? { taskId: args.taskId } : {}),
      goalText: args.goalText,
      decomposedSteps: args.decomposedSteps ?? [],
      llmModel: args.llmModel ?? 'gpt-4.1-mini',
      promptTokens: args.promptTokens ?? 0,
      completionTokens: args.completionTokens ?? 0,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('GoalDecomposition', doc);
    return toDecompositionRow(doc as Doc<'GoalDecomposition'>);
  },
});

/** Delete every decomposition for a task (the standalone CASCADE equivalent; the
 *  AgentTask delete already does this inline). Returns the count deleted. */
export const removeForTask = mutation({
  args: { taskId: v.string() },
  handler: async (ctx, args): Promise<{ deleted: number }> => {
    const rows = await ctx.db
      .query('GoalDecomposition')
      .withIndex('by_task', (q) => q.eq('taskId', args.taskId))
      .collect();
    for (const d of rows) await ctx.db.delete(d._id);
    return { deleted: rows.length };
  },
});
