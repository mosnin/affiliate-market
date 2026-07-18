import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * RefundRequest data access — the Convex replacement for the `.from('RefundRequest')`
 * reads & writes in lib/marketplace/refunds.ts.
 *
 * The eligibility decision (refundEligibility) and the order load (a Convex query,
 * marketplace.orders.guardFields) stay in lib; so does the money movement —
 * approveRefundRequest calls markOrderRefunded (lib→lib) BEFORE marking the
 * request resolved. This module owns only the RefundRequest table hops. No money
 * lives here.
 *
 * UNIQUE(orderId) WHERE status='requested' — one OPEN request per order — is
 * re-implemented as a read-then-insert inside `create`: scan by_order for an
 * existing 'requested' row and refuse with 'already_requested' instead of
 * inserting a duplicate.
 */

const statusValidator = v.union(
  v.literal('requested'),
  v.literal('approved'),
  v.literal('declined'),
);

type RefundFields = {
  id: string;
  orderId: string;
  spaceId: string;
  buyerEmail: string;
  reason?: string;
  status: 'requested' | 'approved' | 'declined';
  createdAt: string;
  resolvedAt?: string;
};

/** The RefundRequestRow shape lib mapRow() produced. Surface id, coerce absent
 *  optionals to SQL NULL. */
function toRow(r: RefundFields) {
  return {
    id: r.id,
    orderId: r.orderId,
    spaceId: r.spaceId,
    buyerEmail: r.buyerEmail,
    reason: r.reason ?? null,
    status: r.status,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt ?? null,
  };
}

export type CreateRefundRequestResult =
  | { ok: true; request: ReturnType<typeof toRow> }
  | { ok: false; error: 'already_requested' };

/**
 * File a refund request. The caller already loaded the order, ran the eligibility
 * guard, and sanitised reason. spaceId comes from the order (lib passes it).
 * Enforces one-open-per-order by reading by_order for a 'requested' row first.
 * status defaults to 'requested' (PG default).
 */
export const create = mutation({
  args: {
    orderId: v.string(),
    spaceId: v.string(),
    buyerEmail: v.string(), // already lowercased by lib
    reason: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<CreateRefundRequestResult> => {
    // One OPEN request per order (idx_refund_request_open_order). by_order is
    // (orderId); filter to the open one.
    const open = await ctx.db
      .query('RefundRequest')
      .withIndex('by_order', (q) => q.eq('orderId', args.orderId))
      .filter((q) => q.eq(q.field('status'), 'requested'))
      .first();
    if (open) return { ok: false, error: 'already_requested' };

    const doc = {
      id: crypto.randomUUID(),
      orderId: args.orderId,
      spaceId: args.spaceId,
      buyerEmail: args.buyerEmail,
      ...(args.reason !== null ? { reason: args.reason } : {}),
      status: 'requested' as const,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('RefundRequest', doc);
    return { ok: true, request: toRow(doc) };
  },
});

/** Latest refund request for an order (by createdAt), or null. Mirrors
 *  `.eq('orderId').order('createdAt', desc).limit(1).maybeSingle()`. */
export const latestForOrder = query({
  args: { orderId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('RefundRequest')
      .withIndex('by_order', (q) => q.eq('orderId', args.orderId))
      .collect();
    if (rows.length === 0) return null;
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return toRow(rows[0]);
  },
});

/** One request by id, or null. Used by the seller-resolver guard in lib. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('RefundRequest')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return r ? toRow(r) : null;
  },
});

/**
 * Refund requests for a space filtered by status (default 'requested'), newest-
 * first (cap 200). idx_refund_request_space_status = (spaceId, status, createdAt
 * DESC) — the compound index carries the order.
 */
export const listForSpace = query({
  args: { spaceId: v.string(), status: v.optional(statusValidator) },
  handler: async (ctx, args) => {
    const status = args.status ?? 'requested';
    const rows = await ctx.db
      .query('RefundRequest')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', status))
      .order('desc')
      .take(200);
    return rows.map(toRow);
  },
});

/**
 * Resolve an OPEN request to approved/declined, stamping resolvedAt. CAS on
 * status='requested' so a stale call can't re-resolve. Returns the updated row,
 * or null if it wasn't still open (lib maps null → no-op). Replaces the
 * `.update({ status, resolvedAt }).eq('id').eq('status','requested')` in both
 * approve/declineRefundRequest. (The money side of approve runs in lib BEFORE
 * this call — markOrderRefunded.)
 */
export const resolve = mutation({
  args: { id: v.string(), status: v.union(v.literal('approved'), v.literal('declined')) },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('RefundRequest')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.status !== 'requested') return null;
    await ctx.db.patch(r._id, { status: args.status, resolvedAt: new Date().toISOString() });
    return toRow((await ctx.db.get(r._id))!);
  },
});
