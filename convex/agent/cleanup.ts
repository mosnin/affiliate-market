import { mutation } from '../_generated/server';
import { v } from 'convex/values';
import { cascadeDeleteTask } from './tasks';

/**
 * Reimplementation of the Postgres stored procedure `cleanup_agent_data()`
 * (supabase/migrations/20260601000006_data_retention.sql) that
 * app/api/cron/cleanup/route.ts calls via `supabase.rpc('cleanup_agent_data')`
 * once per day at 03:00 UTC.
 *
 * The proc batch-deletes stale agentic rows, capped at 1000 per table per call to
 * avoid long locks; backlogs drain over successive daily runs. It returns a jsonb
 * summary of per-table delete counts.
 *
 * Retention windows (verbatim from the SQL):
 *   - ExecutionStep   : COALESCE(startedAt, createdAt) < now - 30 days  (LIMIT 1000)
 *   - AgentTask       : status IN (completed|failed|cancelled)
 *                       AND createdAt < now - 90 days                   (LIMIT 1000)
 *   - AgentMemory     : expiresAt IS NOT NULL AND expiresAt < now       (LIMIT 1000)
 *   - ArtifactVersion : versions whose Artifact->AgentTask createdAt < now-90d (LIMIT 1000)
 *   - Artifact        : artifacts whose AgentTask createdAt < now-90d    (LIMIT 1000)
 *
 * THIS DOMAIN owns ExecutionStep and AgentTask — those two deletes are
 * implemented here. When an AgentTask is deleted, Postgres ran ON DELETE CASCADE
 * to ExecutionStep / GoalDecomposition / TaskCheckpoint / TaskDependency and
 * ON DELETE SET NULL to child AgentTask.parentTaskId / AgentMemory.taskId /
 * Artifact.taskId — so deleting a terminal task here ALSO drops its remaining
 * steps (which is why the explicit ExecutionStep pass + the task-cascade can
 * overlap; both are idempotent). We reuse cascadeDeleteTask (convex/agent/tasks)
 * for the AgentTask deletes so the in-domain cascade matches the DB exactly.
 *
 * ⚠️ CROSS-DOMAIN (NOT this domain's tables — flagged for the integrator, NOT
 * deleted here): AgentMemory (agent-memory domain), Artifact + ArtifactVersion
 * (artifacts domain), and the SET-NULL of AgentMemory.taskId / Artifact.taskId /
 * Artifact.stepId on task/step deletion. Those must be handled by their owning
 * domain's cleanup or wired into this mutation by the integrator once those
 * tables land in Convex. This mutation returns `crossDomainPending: true` and
 * zeroed counts for them so the cron response shape stays compatible
 * ({ deleted_steps, deleted_tasks, deleted_memories, deleted_artifact_versions,
 *   deleted_artifacts, ran_at }).
 */

const BATCH = 1000;
const DAY_MS = 86_400_000;

export const cleanupAgentData = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stepCutoff = new Date(now - 30 * DAY_MS).toISOString();
    const taskCutoff = new Date(now - 90 * DAY_MS).toISOString();

    // ── ExecutionStep: COALESCE(startedAt, createdAt) < now-30d, cap 1000 ──────
    // No single index on COALESCE; scan and filter, then take up to BATCH. (The
    // task-cascade below also deletes steps on aged-out tasks; this pass catches
    // steps on tasks that are NOT yet aged out / already detached.)
    let deletedSteps = 0;
    const stepCandidates = await ctx.db.query('ExecutionStep').collect();
    for (const s of stepCandidates) {
      if (deletedSteps >= BATCH) break;
      const age = s.startedAt ?? s.createdAt;
      if (age < stepCutoff) {
        await ctx.db.delete(s._id);
        deletedSteps++;
      }
    }

    // ── AgentTask: terminal (completed|failed|cancelled) & createdAt<now-90d ────
    // cap 1000. Delete via the shared cascade so children CASCADE / parentTaskId
    // SET NULL exactly as the FKs did. Steps removed by the cascade are not
    // double-counted into deletedSteps (the SQL counted them in the standalone
    // ExecutionStep pass only).
    let deletedTasks = 0;
    const terminal = await ctx.db
      .query('AgentTask')
      .withIndex('by_created', (q) => q.lt('createdAt', taskCutoff))
      .collect();
    for (const t of terminal) {
      if (deletedTasks >= BATCH) break;
      if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
        await cascadeDeleteTask(ctx, t);
        deletedTasks++;
      }
    }

    // ── CROSS-DOMAIN (not owned here) ──────────────────────────────────────────
    // AgentMemory / ArtifactVersion / Artifact deletes are intentionally NOT run
    // here — those tables belong to other domains. Returned as 0 + a flag.
    const deletedMemories = 0;
    const deletedArtifactVersions = 0;
    const deletedArtifacts = 0;

    return {
      deleted_steps: deletedSteps,
      deleted_tasks: deletedTasks,
      deleted_memories: deletedMemories,
      deleted_artifact_versions: deletedArtifactVersions,
      deleted_artifacts: deletedArtifacts,
      ran_at: new Date().toISOString(),
      // Signals the integrator that the three cross-domain deletes still need
      // wiring (AgentMemory, Artifact, ArtifactVersion) — see file header.
      crossDomainPending: true,
    };
  },
});

// Re-export the day constant only for tests that want to assert the windows.
export const RETENTION = { stepDays: 30, taskDays: 90, batch: BATCH };
