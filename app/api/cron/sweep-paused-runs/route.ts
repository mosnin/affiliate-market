/**
 * GET /api/cron/sweep-paused-runs
 *
 * Daily sweeper for AgentPausedRun rows. Without this, every paused-then-
 * abandoned chat turn accumulates indefinitely. The resume route only
 * marks rows expired lazily on access — abandoned runs that the seller
 * never returns to never expire.
 *
 * Behavior:
 *   - Marks `status='expired'` on any pending row past its expiresAt.
 *   - Hard-deletes any row older than 30 days regardless of status.
 *
 * Auth: same Bearer CRON_SECRET pattern as the other cron routes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { monitorCron } from '@/lib/cron-monitor';

const HARD_DELETE_DAYS = 30;

async function handler(req: NextRequest) {
  const auth = req.headers.get('authorization');
  // Guard the unset-secret case: without it, `Bearer undefined` authenticates.
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (process.env.CRON_PAUSED_RUNS_DISABLED === 'true') {
    return NextResponse.json({ ok: true, skipped: 'kill-switch on' });
  }

  const nowIso = new Date().toISOString();
  const cutoffIso = new Date(Date.now() - HARD_DELETE_DAYS * 86_400_000).toISOString();

  // (1) Mark expired anything still pending past its expiresAt.
  let expiredCount: number;
  try {
    const res = await convex().mutation(api.agent.paused.sweepExpire, { now: nowIso });
    expiredCount = res.expired;
  } catch (err) {
    logger.error('[cron.sweep-paused-runs] expire failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'expire failed' }, { status: 500 });
  }

  // (2) Hard-delete anything older than HARD_DELETE_DAYS.
  let deletedCount: number;
  try {
    const res = await convex().mutation(api.agent.paused.sweepDelete, { cutoff: cutoffIso });
    deletedCount = res.deleted;
  } catch (err) {
    logger.error('[cron.sweep-paused-runs] delete failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'delete failed' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    expired: expiredCount,
    deleted: deletedCount,
  });
}

export const GET = monitorCron(
  'sweep-paused-runs',
  { crontab: '0 4 * * *' },
  handler,
);
