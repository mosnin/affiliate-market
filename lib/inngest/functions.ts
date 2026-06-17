/**
 * Inngest functions.
 *
 * publishScheduledPost — fires when a scheduled Studio post comes due. The
 * schedule route sends `studio/post.scheduled` with a delayed `ts`, so the
 * event sits in Inngest's queue until the scheduled minute and the function
 * runs then. It publishes the asset to each connected platform via Composio.
 *
 * One Inngest step per platform: on a retry, a platform that already posted
 * is memoized and never posts twice — only a genuinely failed step re-runs.
 */

import { inngest } from './client';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { getSignedDownloadUrl } from '@/lib/storage';
import { publishToPlatform } from '@/lib/studio/publish';
import { findByComposioId } from '@/lib/integrations/connections';
import {
  dispatchTrigger,
  findByComposioTriggerId,
  stampFired,
} from '@/lib/integrations/triggers';
import { redis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { recordDeadLetter, originalEventData } from './dead-letter';

/** Resolve the space owned by a user (Space.ownerId is unique). Best-effort —
 *  returns 'unknown' so the DLQ write never fails on the NOT NULL spaceId. */
async function spaceIdForOwner(userId: unknown): Promise<string> {
  if (typeof userId !== 'string' || !userId) return 'unknown';
  try {
    const { data } = await supabase.from('Space').select('id').eq('ownerId', userId).maybeSingle();
    return data?.id ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// Per-space daily ceiling on trigger-initiated dispatches. The receiver
// already enforces a per-(connection, slug) hourly cap; this one is the
// total dollar floor. 100/day is conservative: a Modal autonomous run
// is the costliest dispatch path and a single space accumulating 100 of
// them in a day already implies something noisy worth investigating.
// Above the cap → log + drop. The seller noticing "Cola got quiet"
// is a better failure mode than a runaway bill.
const SPACE_DAILY_CAP = 100;
const DAY_SECONDS = 24 * 60 * 60;

interface LoadedPost {
  status: string;
  userId: string;
  caption: string;
  platforms: string[];
  storageKey: string | null;
}

export const publishScheduledPost = inngest.createFunction(
  {
    id: 'studio-publish-scheduled-post',
    triggers: [{ event: 'studio/post.scheduled' }],
    // Capture a permanently-failed publish (all retries exhausted) so it lands
    // in the admin DLQ instead of vanishing.
    onFailure: async (arg) => {
      const data = originalEventData(arg);
      const postId = String(data.postId ?? '');
      let spaceId = 'unknown';
      if (postId) {
        const userId = await convex().query(api.studio.posts.getUserId, { id: postId });
        spaceId = await spaceIdForOwner(userId);
      }
      await recordDeadLetter({
        spaceId,
        eventType: 'studio/post.scheduled',
        eventPayload: { postId },
        error: (arg as { error?: unknown }).error,
      });
    },
  },
  async ({ event, step }) => {
    const postId = String((event.data as { postId?: unknown }).postId ?? '');
    if (!postId) return { skipped: 'no postId' };

    // Load the post and the storage key of its image.
    const post = await step.run('load-post', async (): Promise<LoadedPost | null> => {
      const row = await convex().query(api.studio.posts.getForPublish, { id: postId });
      if (!row) return null;
      // The image's storageKey lives on the File table (a different domain).
      const files = await convex().query(api.infra.files.storageKeysByIds, {
        ids: [row.fileId],
      });
      return {
        status: row.status,
        userId: row.userId,
        caption: row.caption ?? '',
        platforms: row.platforms ?? [],
        storageKey: files[0]?.storageKey ?? null,
      };
    });

    // Gone, or no longer scheduled (canceled / already handled) — stop.
    if (!post || post.status !== 'scheduled') {
      return { skipped: 'not scheduled' };
    }

    if (!post.storageKey) {
      await step.run('mark-missing', async () => {
        await convex().mutation(api.studio.posts.markMissingImage, { id: postId });
        return { done: true };
      });
      return { failed: 'missing image' };
    }

    // Claim it so a duplicate event can't double-publish. Compare-and-swap
    // on `status='scheduled'` — Inngest is at-least-once, so two concurrent
    // deliveries can both read the row at 'scheduled', and without the CAS
    // both would update to 'publishing' and post twice. If the CAS returns
    // no row, another worker already claimed it; bail.
    const claim = await step.run('claim', async () => {
      const claimed = await convex().mutation(api.studio.posts.claimForPublish, { id: postId });
      return { claimed };
    });
    if (!claim.claimed) {
      return { skipped: 'already claimed by another worker' };
    }

    const imageUrl = await step.run('sign-image', () =>
      getSignedDownloadUrl(post.storageKey as string, 3600),
    );

    const platforms = [...new Set(post.platforms)];
    const results: Record<string, { status: string; error?: string }> = {};
    let anyOk = false;
    for (const toolkit of platforms) {
      const outcome = await step.run(`publish-${toolkit}`, () =>
        publishToPlatform({
          toolkit,
          entityId: post.userId,
          imageUrl,
          caption: post.caption,
        }),
      );
      results[toolkit] = outcome.ok
        ? { status: 'posted' }
        : { status: 'failed', error: outcome.error };
      if (outcome.ok) anyOk = true;
    }

    await step.run('finalize', async () => {
      await convex().mutation(api.studio.posts.finalize, {
        id: postId,
        posted: anyOk,
        platformResults: results,
      });
      return { done: true };
    });

    return { postId, posted: anyOk, results };
  },
);

/**
 * handleComposioTrigger — receives `composio/trigger.received` events from
 * the /api/webhooks/composio receiver. The receiver has already verified
 * the HMAC signature, deduped the delivery, and rate-capped the source;
 * this function's job is to:
 *
 *   1. Resolve the IntegrationConnection (by composioConnectionId) and
 *      IntegrationTrigger (by composioTriggerId) so we can act on the
 *      seller's space/user. If either is missing or non-active, drop.
 *   2. Hand off to `dispatchTrigger`, which routes the event to one of
 *      DRAFT (autonomous Modal run), NOTICE (activity card — Phase 4),
 *      DATA_SYNC (direct DB write — Phase 4).
 *   3. Stamp `lastFiredAt` on the trigger row so the health endpoint can
 *      surface stale registrations.
 *
 * Inngest retries on a thrown error. The downstream paths (`fireRoutineRun`
 * etc.) are idempotent on (space, instruction) by design — a retry that
 * re-fires Modal would at worst produce a duplicate draft, which the
 * seller can dismiss. We accept that risk over the alternative of
 * eating the error and losing the event.
 */
export const handleComposioTrigger = inngest.createFunction(
  {
    id: 'composio-handle-trigger',
    triggers: [{ event: 'composio/trigger.received' }],
    // Capture a permanently-failed trigger dispatch in the admin DLQ.
    onFailure: async (arg) => {
      const data = originalEventData(arg);
      const spaceId = await spaceIdForOwner(data.userId);
      await recordDeadLetter({
        spaceId,
        eventType: 'composio/trigger.received',
        eventPayload: {
          deliveryId: data.deliveryId,
          triggerSlug: data.triggerSlug,
          toolkitSlug: data.toolkitSlug,
        },
        error: (arg as { error?: unknown }).error,
      });
    },
  },
  async ({ event, step }) => {
    const data = event.data as {
      deliveryId: string;
      triggerSlug: string;
      toolkitSlug: string;
      composioConnectionId: string;
      composioTriggerId: string;
      userId: string;
      payload: Record<string, unknown>;
    };

    // 0. In-handler idempotency. The receiver dedupes on webhook-id at
    //    HTTP-arrival time, but Inngest itself is at-least-once: if a
    //    later step fails and the function retries, the dispatch step
    //    re-runs and fires Modal again (fireRoutineRun is fire-and-
    //    forget, so it creates a duplicate run). Claim a Redis key on
    //    deliveryId at the head of the function so a retry sees the
    //    claim and short-circuits. The first run's claim is memoised
    //    by step.run, so the claim is genuinely once-per-event.
    const claimed = await step.run('claim-delivery', async () => {
      const key = `composio:trigger:handler:${data.deliveryId}`;
      return redis.set(key, '1', { nx: true, ex: 24 * 60 * 60 });
    });
    if (claimed === null) {
      logger.info('[composio.trigger] duplicate handler invocation — dropping', {
        deliveryId: data.deliveryId,
        triggerSlug: data.triggerSlug,
      });
      return { dispatched: 'noop', reason: 'duplicate_handler' };
    }

    // 1. Resolve the connection. If it's gone (mid-disconnect) or non-active,
    //    drop the event. The receiver already verified the signature so we
    //    know the delivery is authentic — we just no longer care about it.
    const connection = await step.run('resolve-connection', async () => {
      return findByComposioId(data.composioConnectionId);
    });
    if (!connection) {
      logger.info('[composio.trigger] no IntegrationConnection — dropping', {
        composioConnectionId: data.composioConnectionId,
        triggerSlug: data.triggerSlug,
      });
      return { dispatched: 'noop', reason: 'no_connection' };
    }
    if (connection.status !== 'active') {
      logger.info('[composio.trigger] connection not active — dropping', {
        connectionId: connection.id,
        status: connection.status,
        triggerSlug: data.triggerSlug,
      });
      return { dispatched: 'noop', reason: 'connection_inactive' };
    }

    // Defense in depth: the delivery's toolkitSlug should match the
    // connection we resolved. A mismatch means someone is re-using a
    // composioConnectionId across toolkits — shouldn't happen with
    // Composio's data model, but if it ever does, we don't want a Gmail
    // trigger to dispatch against a HubSpot connection.
    if (data.toolkitSlug && data.toolkitSlug !== connection.toolkit) {
      logger.warn('[composio.trigger] toolkit mismatch — dropping', {
        connectionId: connection.id,
        connectionToolkit: connection.toolkit,
        eventToolkit: data.toolkitSlug,
      });
      return { dispatched: 'noop', reason: 'toolkit_mismatch' };
    }

    // 2. Resolve the trigger row. Missing = stale registration (Composio
    //    sent for a trigger we don't track) — drop silently. Paused =
    //    seller turned it off; the receiver doesn't know that, the
    //    handler does.
    const triggerRow = await step.run('resolve-trigger', async () => {
      return findByComposioTriggerId(data.composioTriggerId);
    });
    if (!triggerRow) {
      logger.info('[composio.trigger] no IntegrationTrigger — dropping', {
        composioTriggerId: data.composioTriggerId,
        triggerSlug: data.triggerSlug,
      });
      return { dispatched: 'noop', reason: 'no_trigger' };
    }
    if (triggerRow.status !== 'active') {
      logger.info('[composio.trigger] trigger paused — dropping', {
        triggerRowId: triggerRow.id,
        triggerSlug: data.triggerSlug,
      });
      return { dispatched: 'noop', reason: 'trigger_paused' };
    }

    // 3. Per-space daily cap. The receiver's per-(connection, slug)
    //    hourly cap is finer-grained but lets a seller with five
    //    connected apps each at 60/hr accumulate 300+ Modal runs in a
    //    day. This is the absolute ceiling per space.
    const dayBucket = Math.floor(Date.now() / 1000 / DAY_SECONDS);
    const dailyKey = `composio:trigger:space-daily:${connection.spaceId}:${dayBucket}`;
    const dailyCount = await step.run('daily-cap-check', async () => {
      const c = (await redis.incr(dailyKey)) as number;
      if (c === 1) {
        await redis.expire(dailyKey, DAY_SECONDS);
      }
      return c;
    });
    if (dailyCount > SPACE_DAILY_CAP) {
      logger.warn('[composio.trigger] space daily cap exceeded — dropping', {
        spaceId: connection.spaceId,
        triggerSlug: data.triggerSlug,
        count: dailyCount,
        cap: SPACE_DAILY_CAP,
      });
      return { dispatched: 'noop', reason: 'space_daily_cap' };
    }

    // 4. Dispatch. The dispatcher is the single place that decides DRAFT
    //    vs NOTICE vs DATA_SYNC vs no-op based on the slug. deliveryId
    //    threads through so the drafts tool can persist it on
    //    AgentDraft.triggerSource for the inbox "noticed because"
    //    breadcrumb.
    const result = await step.run('dispatch', async () => {
      return dispatchTrigger({
        triggerSlug: data.triggerSlug,
        connection,
        payload: data.payload,
        deliveryId: data.deliveryId,
      });
    });

    // 4. Stamp lastFiredAt only on a real dispatch — a no-op shouldn't
    //    look like a successful fire on the health endpoint.
    if (result.dispatched !== 'noop') {
      await step.run('stamp-fired', () => stampFired(triggerRow.id));
    }

    return {
      deliveryId: data.deliveryId,
      triggerSlug: data.triggerSlug,
      connectionId: connection.id,
      ...result,
    };
  },
);
