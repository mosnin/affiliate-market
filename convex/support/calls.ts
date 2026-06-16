import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * CallLog data access — the Convex replacement for the Supabase reads/writes in
 * app/api/calls/route.ts (GET list / POST place), app/api/calls/[id]/route.ts
 * (GET one), and app/api/webhooks/telnyx-voice/route.ts (lifecycle updates).
 *
 * The old GET list embedded `Contact(name)` to flatten a contactName onto each
 * row. Contact is NOT this domain's table, so the join can't live in a Convex
 * query over CallLog; the route resolves contact names separately (a single
 * Contact read keyed by the contactIds these rows carry) and merges them — the
 * client-facing { ...call, contactName } shape is unchanged.
 *
 * Telnyx/voice plumbing (placeClickToCall, transcription, summary) stays in the
 * route; only the DB hops move here.
 */

const directionValidator = v.union(v.literal('outbound'), v.literal('inbound'));
const statusValidator = v.union(
  v.literal('initiated'),
  v.literal('ringing'),
  v.literal('answered'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('no_answer'),
);

/** App columns of a CallLog — the structural shape both a stored Doc and an
 *  insert payload satisfy (so mappers need no _id / cast). */
type CallFields = {
  id: string;
  spaceId: string;
  contactId?: string;
  direction: 'outbound' | 'inbound';
  fromNumber: string;
  toNumber: string;
  telnyxCallId?: string;
  status: 'initiated' | 'ringing' | 'answered' | 'completed' | 'failed' | 'no_answer';
  recordingUrl?: string;
  transcript?: string;
  summary?: string;
  durationSec?: number;
  createdAt: string;
  updatedAt: string;
};

/** Full legacy CallLog row, fields in CALL_COLUMNS order, absent optionals
 *  coerced to the SQL NULLs the client expects. */
function toRow(c: CallFields) {
  return {
    id: c.id,
    spaceId: c.spaceId,
    contactId: c.contactId ?? null,
    direction: c.direction,
    fromNumber: c.fromNumber,
    toNumber: c.toNumber,
    telnyxCallId: c.telnyxCallId ?? null,
    status: c.status,
    recordingUrl: c.recordingUrl ?? null,
    transcript: c.transcript ?? null,
    summary: c.summary ?? null,
    durationSec: c.durationSec ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * A space's calls, newest first (cap 100). Replaces the GET list read (minus the
 * Contact embed — the route flattens contactName itself). PG had
 * (spaceId, createdAt DESC); the compound index carries the order.
 */
export const listBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CallLog')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .take(100);
    return rows.map(toRow);
  },
});

/**
 * One call by id, scoped to a space, or null. Replaces
 * `.eq('id', id).eq('spaceId', space.id).maybeSingle()` — the spaceId guard
 * stops a caller reading another workspace's call by guessing an id.
 */
export const getByIdInSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('CallLog')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c || c.spaceId !== args.spaceId) return null;
    return toRow(c);
  },
});

/**
 * Insert a call row (status 'initiated' before dialing). direction defaults to
 * 'outbound' (PG column default); contactId is optional. The PG insert set
 * createdAt/updatedAt explicitly — the route still passes `now`, which we use.
 * Returns the row so the route can report exactly what landed.
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    contactId: v.union(v.string(), v.null()),
    direction: v.optional(directionValidator),
    fromNumber: v.string(),
    toNumber: v.string(),
    status: statusValidator,
    createdAt: v.string(),
    updatedAt: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      ...(args.contactId !== null ? { contactId: args.contactId } : {}),
      direction: args.direction ?? ('outbound' as const),
      fromNumber: args.fromNumber,
      toNumber: args.toNumber,
      status: args.status,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    };
    await ctx.db.insert('CallLog', doc);
    return toRow(doc); // in-memory doc mirrors the stored row; no read-back
  },
});

/**
 * Patch a call row by id (the place-call follow-ups: mark 'failed', stamp
 * telnyxCallId). updatedAt always bumps. Returns the updated row (or null if the
 * id vanished); the route falls back to its in-memory row when null.
 */
export const updateById = mutation({
  args: {
    id: v.string(),
    status: v.optional(statusValidator),
    telnyxCallId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('CallLog')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c) return null;
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.telnyxCallId !== undefined) patch.telnyxCallId = args.telnyxCallId;
    await ctx.db.patch(c._id, patch);
    return toRow((await ctx.db.get(c._id))!);
  },
});

/**
 * Patch the call row matching a Telnyx call_control_id (the webhook's only
 * correlation key). Replaces `updateByCallId`'s `.update({...}).eq('telnyxCallId')`.
 * No-op when no row matches (the webhook tolerates that). updatedAt always bumps.
 *
 * Fields are passed as explicit optionals (status / durationSec / recordingUrl /
 * transcript / summary) so the validator stays tight rather than a free v.any();
 * each maps to exactly the columns the webhook writes.
 */
export const updateByTelnyxId = mutation({
  args: {
    telnyxCallId: v.string(),
    status: v.optional(statusValidator),
    durationSec: v.optional(v.number()),
    recordingUrl: v.optional(v.string()),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    // PG `.update().eq('telnyxCallId')` patches EVERY matching row. telnyxCallId
    // is effectively unique per call, but collect-then-patch matches the old
    // semantics exactly and avoids a `.unique()` throw if two rows ever shared
    // an id (this webhook must never throw destructively).
    const rows = await ctx.db
      .query('CallLog')
      .withIndex('by_telnyx', (q) => q.eq('telnyxCallId', args.telnyxCallId))
      .collect();
    if (rows.length === 0) return;
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.durationSec !== undefined) patch.durationSec = args.durationSec;
    if (args.recordingUrl !== undefined) patch.recordingUrl = args.recordingUrl;
    if (args.transcript !== undefined) patch.transcript = args.transcript;
    if (args.summary !== undefined) patch.summary = args.summary;
    for (const c of rows) await ctx.db.patch(c._id, patch);
  },
});
