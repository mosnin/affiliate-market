import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * Brief data access — the Convex replacement for the `.from('Brief')` reads &
 * writes across the daily-briefing cron, the agent/briefing on-demand compose +
 * PATCH, the /test endpoint, the delivery fan-out (lib/briefing/delivery.ts),
 * and the read-only analytics (lib/briefing/analytics.ts).
 *
 * The composition, email/SMS rendering, sending, and all the brief MATH stay in
 * lib — only the DB hops move here. Two real invariants are preserved inside
 * single (serializable) mutations:
 *
 *   - UNIQUE(spaceId, forDate) — one brief per space per local date. `upsert`
 *     re-implements the PG `.upsert(onConflict: 'spaceId,forDate')` as
 *     read-by-(space,date)-then-insert-or-patch.
 *   - The delivery lock CAS. lib/briefing/delivery.ts claimed a channel by
 *     `UPDATE Brief SET emailSentAt=now WHERE id=? AND emailSentAt IS NULL
 *     RETURNING id` — only the tick that got a row sends. `claimEmail` /
 *     `claimSms` reproduce that exactly: patch-if-still-null, return whether THIS
 *     call won. `releaseEmail` / `releaseSms` mirror the transient-failure
 *     rollback (`UPDATE ... SET sentAt=null WHERE id=? AND messageId IS NULL`).
 */

/** App columns of a Brief. Both a stored Doc and a fresh insert payload satisfy
 *  this — mappers need no cast. */
type BriefFields = {
  id: string;
  spaceId: string;
  forDate: string;
  status: string;
  payload: unknown;
  createdAt: string;
  seenAt?: string;
  actedAt?: string;
  cardMeta: unknown;
  cardTaps: unknown;
  emailSentAt?: string;
  smsSentAt?: string;
  emailMessageId?: string;
  smsMessageId?: string;
  briefDeliveryErrorCode?: string;
};

/** The full Brief row in the legacy shape (drop _id/_creationTime, surface `id`,
 *  coerce absent optionals to SQL NULL, default the jsonb arrays to []). The
 *  agent/briefing routes read the `id, status, payload, createdAt, seenAt,
 *  actedAt` subset; this superset covers every SELECT. */
function toRow(b: BriefFields) {
  return {
    id: b.id,
    spaceId: b.spaceId,
    forDate: b.forDate,
    status: b.status,
    payload: b.payload ?? null,
    createdAt: b.createdAt,
    seenAt: b.seenAt ?? null,
    actedAt: b.actedAt ?? null,
    cardMeta: Array.isArray(b.cardMeta) ? b.cardMeta : [],
    cardTaps: Array.isArray(b.cardTaps) ? b.cardTaps : [],
    emailSentAt: b.emailSentAt ?? null,
    smsSentAt: b.smsSentAt ?? null,
    emailMessageId: b.emailMessageId ?? null,
    smsMessageId: b.smsMessageId ?? null,
    briefDeliveryErrorCode: b.briefDeliveryErrorCode ?? null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The single brief for (spaceId, forDate), or null. UNIQUE(spaceId, forDate).
 *  Mirrors the agent/briefing `.eq('spaceId').eq('forDate').maybeSingle()` reads
 *  (yesterday's, today's, and the PATCH pre-read). */
export const getBySpaceDate = query({
  args: { spaceId: v.string(), forDate: v.string() },
  handler: async (ctx, args) => {
    const b = await ctx.db
      .query('Brief')
      .withIndex('by_space_date', (q) => q.eq('spaceId', args.spaceId).eq('forDate', args.forDate))
      .unique();
    return b ? toRow(b) : null;
  },
});

/** Briefs created in [since, until) — the analytics window scan (briefOpenRate,
 *  sourceTapRates, confidenceCalibration). PG had no index on Brief.createdAt, so
 *  this collects and filters in memory exactly as the analytics did over its
 *  result set. Returns the full rows; the lib does the bucket math. */
export const listCreatedBetween = query({
  args: { since: v.string(), until: v.string() },
  handler: async (ctx, args) => {
    const rows: Doc<'Brief'>[] = await ctx.db.query('Brief').collect();
    return rows
      .filter((b) => b.createdAt >= args.since && b.createdAt < args.until)
      .map(toRow);
  },
});

/** Count of a space's briefs whose smsSentAt is set, EXCLUDING `excludeBriefId` —
 *  the "is this the seller's first-ever brief SMS?" check in deliverSms (PG:
 *  `.eq('spaceId').not('smsSentAt','is',null).neq('id', briefId)` with
 *  count: 'exact', head: true). Returns the integer count. */
export const countPriorSmsSends = query({
  args: { spaceId: v.string(), excludeBriefId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Brief')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.filter((b) => b.smsSentAt != null && b.id !== args.excludeBriefId).length;
  },
});

// ── Compose write (upsert one-per-space-per-date) ────────────────────────────

/**
 * Upsert today's brief for (spaceId, forDate). Replaces the cron's
 * `.upsert({ spaceId, forDate, status:'pending', payload, cardMeta },
 * { onConflict: 'spaceId,forDate' })` AND the agent/briefing on-demand INSERT
 * (which only runs when no row exists — the upsert subsumes both).
 *
 * UNIQUE(spaceId, forDate) is preserved by reading the (space,date) row first
 * and patching it (re-compose: same payload/cardMeta refresh, status reset to
 * 'pending') or inserting a fresh one. cardMeta defaults to [] (the /test path
 * passes []). Returns the full row (callers need at least `id`).
 */
export const upsert = mutation({
  args: {
    spaceId: v.string(),
    forDate: v.string(),
    payload: v.any(),
    cardMeta: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const cardMeta = Array.isArray(args.cardMeta) ? args.cardMeta : [];
    const existing = await ctx.db
      .query('Brief')
      .withIndex('by_space_date', (q) => q.eq('spaceId', args.spaceId).eq('forDate', args.forDate))
      .unique();

    if (existing) {
      // Re-compose refreshes payload + cardMeta and resets status to 'pending'
      // (the upsert overwrote those columns). Delivery-lock / seen columns are
      // left intact — the upsert payload never touched them.
      await ctx.db.patch(existing._id, {
        status: 'pending',
        payload: args.payload,
        cardMeta,
      });
      return toRow((await ctx.db.get(existing._id))!);
    }

    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      forDate: args.forDate,
      status: 'pending',
      payload: args.payload,
      cardMeta,
      cardTaps: [],
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('Brief', doc);
    return toRow(doc);
  },
});

// ── PATCH (seen / acted / card taps) ─────────────────────────────────────────

/**
 * Patch a brief's engagement columns by id. Replaces the agent/briefing PATCH
 * `.update({ seenAt?, status?, cardTaps? }).eq('id', existing.id)` (the route
 * resolves the brief by (space, forDate) first via getBySpaceDate, then calls
 * this with its id). Only provided fields change. No-op if the row vanished.
 */
export const patchEngagement = mutation({
  args: {
    id: v.string(),
    seenAt: v.optional(v.string()),
    actedAt: v.optional(v.string()),
    status: v.optional(v.string()),
    cardTaps: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<void> => {
    const b = await ctx.db
      .query('Brief')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!b) return;
    const patch: Record<string, unknown> = {};
    if (args.seenAt !== undefined) patch.seenAt = args.seenAt;
    if (args.actedAt !== undefined) patch.actedAt = args.actedAt;
    if (args.status !== undefined) patch.status = args.status;
    if (args.cardTaps !== undefined) patch.cardTaps = args.cardTaps;
    if (Object.keys(patch).length > 0) await ctx.db.patch(b._id, patch);
  },
});

/** Delete a brief by id — the /test endpoint's synthetic-row cleanup
 *  (`.delete().eq('id', row.id)`). No-op if already gone. */
export const deleteById = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const b = await ctx.db
      .query('Brief')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (b) await ctx.db.delete(b._id);
  },
});

// ── Delivery lock CAS + bookkeeping (lib/briefing/delivery.ts) ────────────────

/**
 * Atomic email-delivery claim: set emailSentAt=now WHERE emailSentAt IS NULL.
 * Returns true iff THIS call won the lock (the row was unclaimed). Mirrors the PG
 * `.update({emailSentAt}).eq('id').is('emailSentAt',null).select('id').maybeSingle()`
 * — a non-null result meant this tick won. Serializable, so no two ticks claim.
 */
export const claimEmail = mutation({
  args: { id: v.string(), sentAt: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const b = await ctx.db
      .query('Brief')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!b) return false; // missing row == lost claim (PG returned no row)
    if (b.emailSentAt != null) return false; // already claimed by another tick
    await ctx.db.patch(b._id, { emailSentAt: args.sentAt });
    return true;
  },
});

/** Atomic SMS-delivery claim — the smsSentAt twin of claimEmail. */
export const claimSms = mutation({
  args: { id: v.string(), sentAt: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const b = await ctx.db
      .query('Brief')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!b) return false;
    if (b.smsSentAt != null) return false;
    await ctx.db.patch(b._id, { smsSentAt: args.sentAt });
    return true;
  },
});

/**
 * Release the email lock on transient failure so a later tick retries within the
 * same day: emailSentAt=null WHERE emailMessageId IS NULL. The guard keeps a
 * brief that DID actually send (messageId present) locked. Mirrors
 * `.update({emailSentAt:null}).eq('id').is('emailMessageId',null)`.
 */
export const releaseEmail = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const b = await ctx.db
      .query('Brief')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!b) return;
    if (b.emailMessageId != null) return; // a real send happened — keep the lock
    await ctx.db.patch(b._id, { emailSentAt: undefined });
  },
});

/** Release the SMS lock on transient failure — the smsMessageId twin of
 *  releaseEmail (`.update({smsSentAt:null}).eq('id').is('smsMessageId',null)`). */
export const releaseSms = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const b = await ctx.db
      .query('Brief')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!b) return;
    if (b.smsMessageId != null) return;
    await ctx.db.patch(b._id, { smsSentAt: undefined });
  },
});

/**
 * Record email delivery success: write emailMessageId and clear
 * briefDeliveryErrorCode. Mirrors the post-send
 * `.update({emailMessageId, briefDeliveryErrorCode:null}).eq('id')`. messageId
 * may be null (Resend returned none) — null clears the optional column.
 */
export const recordEmailSent = mutation({
  args: { id: v.string(), messageId: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<void> => {
    const b = await ctx.db
      .query('Brief')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!b) return;
    await ctx.db.patch(b._id, {
      emailMessageId: args.messageId === null ? undefined : args.messageId,
      briefDeliveryErrorCode: undefined,
    });
  },
});

/** Record SMS delivery success: clear briefDeliveryErrorCode. Mirrors the
 *  post-send `.update({briefDeliveryErrorCode:null}).eq('id')`. (The SMS path
 *  never writes smsMessageId — sendSMS doesn't surface one to this layer.) */
export const recordSmsSent = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const b = await ctx.db
      .query('Brief')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!b) return;
    await ctx.db.patch(b._id, { briefDeliveryErrorCode: undefined });
  },
});

/** Stamp a permanent-failure error code (keeps the lock). Mirrors the
 *  `.update({briefDeliveryErrorCode: code}).eq('id')` in handleEmailFailure's
 *  permanent branch (code e.g. 'email_permanent'). */
export const recordDeliveryError = mutation({
  args: { id: v.string(), errorCode: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const b = await ctx.db
      .query('Brief')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!b) return;
    await ctx.db.patch(b._id, { briefDeliveryErrorCode: args.errorCode });
  },
});
