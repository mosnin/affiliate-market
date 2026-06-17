/**
 * GET /api/cron/cleanup
 *
 * Triggered once per day at 03:00 UTC by Vercel Cron (see vercel.json).
 * Calls the Postgres cleanup_agent_data() function which batches-deletes
 * stale rows from ExecutionStep, AgentTask, AgentMemory, ArtifactVersion,
 * and Artifact — capped at 1 000 rows per table per call to avoid long
 * locks. Backlogs drain over successive daily runs.
 *
 * Auth: requires Authorization: Bearer <CRON_SECRET> header. Vercel Cron
 * injects this automatically when CRON_SECRET is set in project env vars.
 * Returns 401 immediately if the header is absent or wrong.
 */

import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { monitorCron } from '@/lib/cron-monitor';

async function handler(req: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Run cleanup ───────────────────────────────────────────────────────────
  // Convex port of the cleanup_agent_data() proc. Returns the same jsonb count
  // shape ({ deleted_steps, deleted_tasks, deleted_memories,
  // deleted_artifact_versions, deleted_artifacts, ran_at }). NOTE: the
  // cross-domain AgentMemory / Artifact / ArtifactVersion deletes are flagged
  // pending in the mutation (crossDomainPending: true, zeroed counts) until
  // those tables land in Convex — see convex/agent/cleanup.ts.
  let data: Record<string, unknown>;
  try {
    data = await convex().mutation(api.agent.cleanup.cleanupAgentData, {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[cron.cleanup] cleanupAgentData failed', { err: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  logger.info('[cron.cleanup] cleanup complete', { result: data });

  return NextResponse.json({ ok: true, ...data });
}

export const GET = monitorCron('cleanup', { crontab: '0 3 * * *' }, handler);
