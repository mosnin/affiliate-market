import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * FormAnalyticsEvent data access — the Convex replacement for the two
 * `.from('FormAnalyticsEvent')` ops in app/api/form-analytics/route.ts: the
 * append-only batch INSERT (POST) and the auth'd windowed SELECT (GET).
 *
 * The metadata/stepTitle sanitization stays in the route (it strips sensitive
 * keys + HTML before this layer sees the rows). This module just persists/reads.
 */

const eventTypeValidator = v.union(
  v.literal('form_start'),
  v.literal('step_view'),
  v.literal('step_complete'),
  v.literal('form_submit'),
  v.literal('form_abandon'),
);

/** One sanitized event the route hands in. Nullable columns arrive as null from
 *  the route's `?? null` normalization; we store them as absent (== SQL NULL). */
const eventInput = v.object({
  spaceId: v.string(),
  sessionId: v.string(),
  formConfigVersion: v.union(v.number(), v.null()),
  eventType: eventTypeValidator,
  stepIndex: v.union(v.number(), v.null()),
  stepTitle: v.union(v.string(), v.null()),
  durationMs: v.union(v.number(), v.null()),
  metadata: v.union(v.any(), v.null()),
});

/**
 * Batch-insert sanitized analytics events (POST). Replaces
 * `.from('FormAnalyticsEvent').insert(sanitizedEvents)`. Each row gets a fresh
 * uuid id + createdAt=now (PG defaults). null nullable fields are stored absent.
 * Returns the inserted count (the route reports it).
 */
export const insertBatch = mutation({
  args: { events: v.array(eventInput) },
  handler: async (ctx, args): Promise<{ count: number }> => {
    const now = new Date().toISOString();
    for (const e of args.events) {
      await ctx.db.insert('FormAnalyticsEvent', {
        id: crypto.randomUUID(),
        spaceId: e.spaceId,
        sessionId: e.sessionId,
        ...(e.formConfigVersion !== null ? { formConfigVersion: e.formConfigVersion } : {}),
        eventType: e.eventType,
        ...(e.stepIndex !== null ? { stepIndex: e.stepIndex } : {}),
        ...(e.stepTitle !== null ? { stepTitle: e.stepTitle } : {}),
        ...(e.durationMs !== null ? { durationMs: e.durationMs } : {}),
        metadata: e.metadata ?? {},
        createdAt: now,
      });
    }
    return { count: args.events.length };
  },
});

/**
 * The auth'd analytics read (GET): events for a space since `cutoff`, ordered
 * createdAt asc, cap 10000, optionally filtered to one formConfigVersion.
 * Mirrors `.select(...).eq('spaceId').gte('createdAt', cutoff)
 * [.eq('formConfigVersion', v)].order('createdAt', asc).limit(10000)`. Returns
 * the columns the route folds (id surfaced, absent optionals -> null).
 */
export const listForSpace = query({
  args: {
    spaceId: v.string(),
    cutoff: v.string(),
    formConfigVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('FormAnalyticsEvent')
      .withIndex('by_space_created', (q) =>
        q.eq('spaceId', args.spaceId).gte('createdAt', args.cutoff),
      )
      .collect();
    const filtered =
      args.formConfigVersion === undefined
        ? rows
        : rows.filter((r) => r.formConfigVersion === args.formConfigVersion);
    // index range already yields createdAt asc; cap at 10000 to match the limit.
    return filtered.slice(0, 10000).map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      formConfigVersion: r.formConfigVersion ?? null,
      eventType: r.eventType,
      stepIndex: r.stepIndex ?? null,
      stepTitle: r.stepTitle ?? null,
      durationMs: r.durationMs ?? null,
      metadata: r.metadata ?? null,
      createdAt: r.createdAt,
    }));
  },
});
