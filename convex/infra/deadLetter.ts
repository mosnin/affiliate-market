import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * DeadLetterEvent data access — the Convex replacement for `.from('DeadLetterEvent')`
 * in lib/inngest/dead-letter.ts (the producer) and the admin DLQ routes
 * (list / get / create / patch). Append-mostly: producer inserts on final
 * Inngest retry exhaustion; admins list/inspect/resolve/retry.
 *
 * No upsert: every failure inserts a NEW row (the producer never matches an
 * existing row by spaceId/eventType/taskId). The "retry" admin action bumps a
 * counter on the SAME row by id — that's a patch, not an insert.
 *
 * ⚠️ PRESERVED CALL-SITE DISCREPANCY (flagged for the integrator):
 * the admin DLQ POST/PATCH routes reference columns that DO NOT EXIST on the
 * Postgres table — `payload` (real: eventPayload), `error` (real: errorMessage),
 * and `retryCount` (real: attemptCount). Today those Supabase writes/reads
 * silently no-op (the columns aren't there) and the PATCH reads `existing.retryCount
 * ?? 0` (always undefined → 0). To keep the call-site contract byte-for-byte:
 *   - `createFromAdmin` writes the alias fields (payload/error/retryCount) AS-IS
 *     so the route's read-back round-trips unchanged; it does NOT silently remap
 *     them to the real columns (that would change behavior the next wave depends
 *     on — a real fix is a separate, deliberate change).
 *   - `patch` accepts `retryCount` and stores it on the alias field.
 *   - `getById` returns BOTH the real columns and the alias fields (alias →
 *     undefined for producer rows, matching the old `?? 0`).
 * The producer (`record`) uses ONLY the real columns and is correct.
 */

const statusValidator = v.union(
  v.literal('pending'),
  v.literal('retrying'),
  v.literal('resolved'),
  v.literal('abandoned'),
);

/** Return the full stored doc minus Convex internals, exposing `id`. Includes
 *  the alias fields (payload/error/retryCount) so the admin routes read back
 *  exactly what they wrote. Producer rows leave the aliases undefined → null. */
function toRow(d: Doc<'DeadLetterEvent'>) {
  return {
    id: d.id,
    spaceId: d.spaceId,
    eventType: d.eventType,
    eventPayload: d.eventPayload ?? null,
    errorMessage: d.errorMessage,
    errorStack: d.errorStack ?? null,
    attemptCount: d.attemptCount,
    firstFailedAt: d.firstFailedAt,
    lastFailedAt: d.lastFailedAt,
    resolvedAt: d.resolvedAt ?? null,
    resolvedBy: d.resolvedBy ?? null,
    resolutionNote: d.resolutionNote ?? null,
    status: d.status,
    taskId: d.taskId ?? null,
    createdAt: d.createdAt,
    // Alias fields the admin routes use (see header).
    payload: d.payload ?? null,
    error: d.error ?? null,
    retryCount: d.retryCount ?? null,
  };
}

// ── Producer write (correct columns) ─────────────────────────────────────────

/** recordDeadLetter(): insert a dead-letter row after final retry exhaustion.
 *  Mirrors lib/inngest/dead-letter.ts's `.insert({ spaceId, eventType,
 *  eventPayload, errorMessage, errorStack, taskId, status:'pending' })`.
 *  attemptCount / firstFailedAt / lastFailedAt default (PG defaulted them):
 *  attemptCount=1, the timestamps to now(). */
export const record = mutation({
  args: {
    spaceId: v.string(),
    eventType: v.string(),
    eventPayload: v.optional(v.any()),
    errorMessage: v.string(),
    errorStack: v.union(v.string(), v.null()),
    taskId: v.union(v.string(), v.null()),
    status: v.optional(statusValidator),
  },
  handler: async (ctx, args): Promise<void> => {
    const now = new Date().toISOString();
    await ctx.db.insert('DeadLetterEvent', {
      id: crypto.randomUUID(),
      spaceId: args.spaceId || 'unknown',
      eventType: args.eventType,
      eventPayload: args.eventPayload ?? {},
      errorMessage: args.errorMessage,
      ...(args.errorStack !== null ? { errorStack: args.errorStack } : {}),
      attemptCount: 1,
      firstFailedAt: now,
      lastFailedAt: now,
      status: args.status ?? 'pending',
      ...(args.taskId !== null ? { taskId: args.taskId } : {}),
      createdAt: now,
    });
  },
});

// ── Admin reads ──────────────────────────────────────────────────────────────

/** GET /api/admin/dlq list: newest-first, optional spaceId and/or status,
 *  capped (1..200, default 50). Mirrors `.select('*')[.eq('spaceId')]
 *  [.eq('status')].order(createdAt desc).limit(limit)`. Filters applied in
 *  handler so any combination of the two optional filters works on one path. */
export const list = query({
  args: {
    spaceId: v.optional(v.string()),
    status: v.optional(statusValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    let rows: Doc<'DeadLetterEvent'>[];
    if (args.status !== undefined) {
      rows = await ctx.db
        .query('DeadLetterEvent')
        .withIndex('by_status', (q) => q.eq('status', args.status!))
        .collect();
    } else if (args.spaceId !== undefined) {
      rows = await ctx.db
        .query('DeadLetterEvent')
        .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId!))
        .collect();
    } else {
      rows = await ctx.db.query('DeadLetterEvent').collect();
    }
    if (args.spaceId !== undefined) rows = rows.filter((r) => r.spaceId === args.spaceId);
    if (args.status !== undefined) rows = rows.filter((r) => r.status === args.status);
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.slice(0, limit).map(toRow);
  },
});

/** GET /api/admin/dlq/[eventId] + the PATCH pre-fetch: one row by id, or null.
 *  Mirrors `.select('*').eq('id', eventId).maybeSingle()`. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('DeadLetterEvent')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return d ? toRow(d) : null;
  },
});

// ── Admin writes ─────────────────────────────────────────────────────────────

/** POST /api/admin/dlq: admin/service-role manual create. Mirrors the route's
 *  `.insert({ spaceId, eventType, payload, error, status:'pending', retryCount:0 })`
 *  — note it writes the ALIAS fields payload/error/retryCount (see header), NOT
 *  eventPayload/errorMessage/attemptCount. Preserved verbatim. errorMessage is
 *  set to the same string so the row still satisfies the NOT-NULL real column.
 *  Returns the inserted row (the route `.select().maybeSingle()`s it). */
export const createFromAdmin = mutation({
  args: {
    spaceId: v.string(),
    eventType: v.string(),
    payload: v.any(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await ctx.db.insert('DeadLetterEvent', {
      id,
      spaceId: args.spaceId,
      eventType: args.eventType,
      // Real NOT-NULL columns still populated so the row is well-formed.
      eventPayload: args.payload,
      errorMessage: args.error,
      attemptCount: 0,
      firstFailedAt: now,
      lastFailedAt: now,
      status: 'pending',
      createdAt: now,
      // Alias fields the route wrote + reads back.
      payload: args.payload,
      error: args.error,
      retryCount: 0,
    });
    const d = (await ctx.db
      .query('DeadLetterEvent')
      .withIndex('by_app_id', (q) => q.eq('id', id))
      .unique())!;
    return toRow(d);
  },
});

/** PATCH /api/admin/dlq/[eventId]: resolve or retry. The route computed the
 *  payload (resolve → {status:'resolved', resolvedAt}; retry → {retryCount:n,
 *  status}) and we apply it by id, returning the updated row. retryCount lands
 *  on the alias field (see header). No-op if the row vanished. */
export const patch = mutation({
  args: {
    id: v.string(),
    status: v.optional(statusValidator),
    resolvedAt: v.optional(v.string()),
    retryCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('DeadLetterEvent')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d) return null;
    const patchFields: Record<string, unknown> = {};
    if (args.status !== undefined) patchFields.status = args.status;
    if (args.resolvedAt !== undefined) patchFields.resolvedAt = args.resolvedAt;
    if (args.retryCount !== undefined) patchFields.retryCount = args.retryCount;
    if (Object.keys(patchFields).length > 0) await ctx.db.patch(d._id, patchFields);
    const updated = (await ctx.db.get(d._id))!;
    return toRow(updated);
  },
});
