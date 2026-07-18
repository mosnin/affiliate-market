/**
 * Buyer-initiated refund requests — the missing half of the refund loop.
 *
 * The seller can already PROCESS a refund (orders.ts `markOrderRefunded`); this
 * module lets the buyer ASK for one. A request is only created after a guard:
 * the order must exist, belong to this buyer (case-insensitive email match),
 * and be 'paid' — refunded / pending / canceled orders are rejected. One open
 * request per order is enforced both here (friendly error) and by the partial
 * unique index, now re-implemented as a read-then-insert inside the Convex
 * create mutation (race-safe backstop).
 *
 * No money lives here. This is a signal — the seller still settles the refund
 * with their existing action. So the net/gross rules don't apply. Every DB hop
 * (MarketplaceOrder guard, RefundRequest) is a Convex call.
 */
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { markOrderRefunded } from '@/lib/marketplace/orders';

export type RefundRequestStatus = 'requested' | 'approved' | 'declined';

const MAX_REASON = 1000;

export interface RefundRequestRow {
  id: string;
  orderId: string;
  spaceId: string;
  buyerEmail: string;
  reason: string | null;
  status: RefundRequestStatus;
  createdAt: string;
  resolvedAt: string | null;
}

/** Discriminated result so the route can map cleanly to status codes. */
export type CreateRefundRequestResult =
  | { ok: true; request: RefundRequestRow }
  | { ok: false; error: 'not_found' | 'not_paid' | 'not_owner' | 'already_requested' };

/**
 * Pure eligibility decision — the whole "can this buyer request a refund on
 * this order" rule, with no database. Factored out so it can be unit-tested and
 * so `createRefundRequest` reads as one guard. Email match is case-insensitive
 * (Foo@x.com and foo@x.com are the same owner). Only 'paid' orders are
 * refundable; anything else is 'not_paid'.
 */
export function refundEligibility(
  order: { status: string; buyerEmail: string },
  requesterEmail: string,
): 'ok' | 'not_paid' | 'not_owner' {
  if (order.buyerEmail.trim().toLowerCase() !== requesterEmail.trim().toLowerCase()) {
    return 'not_owner';
  }
  if (order.status !== 'paid') return 'not_paid';
  return 'ok';
}

/**
 * File a refund request. Loads the order, runs the eligibility guard, rejects a
 * duplicate open request, then inserts. spaceId is taken from the order row —
 * never trusted from the caller. Returns a discriminated result.
 */
export async function createRefundRequest(input: {
  orderId: string;
  buyerEmail: string;
  reason?: string | null;
}): Promise<CreateRefundRequestResult> {
  const orderId = input.orderId.trim();
  const requesterEmail = input.buyerEmail.trim().toLowerCase();

  // Load the order directly — cheap targeted read, gives us status + owner +
  // spaceId without pulling the buyer's whole history through orders.ts.
  const order = (await convex().query(api.marketplace.orders.guardFields, {
    id: orderId,
  })) as { id: string; spaceId: string; buyerEmail: string; status: string } | null;

  if (!order) return { ok: false, error: 'not_found' };

  const eligibility = refundEligibility(
    { status: order.status, buyerEmail: order.buyerEmail },
    requesterEmail,
  );
  // not_owner before not_paid: don't leak an order's payment state to someone
  // who doesn't own it.
  if (eligibility === 'not_owner') return { ok: false, error: 'not_owner' };
  if (eligibility === 'not_paid') return { ok: false, error: 'not_paid' };

  const reason = (input.reason ?? '').trim().slice(0, MAX_REASON) || null;

  // One open request per order. The read-then-insert inside the mutation is the
  // race-safe backstop the partial unique index used to provide.
  const result = (await convex().mutation(api.marketplace.refunds.create, {
    orderId,
    spaceId: order.spaceId,
    buyerEmail: requesterEmail,
    reason,
  })) as { ok: true; request: RefundRequestRow } | { ok: false; error: 'already_requested' };

  if (!result.ok) return { ok: false, error: 'already_requested' };
  return { ok: true, request: result.request };
}

/** Latest refund request for an order (by createdAt), or null. */
export async function getRefundRequestForOrder(orderId: string): Promise<RefundRequestRow | null> {
  const data = (await convex().query(api.marketplace.refunds.latestForOrder, {
    orderId,
  })) as RefundRequestRow | null;
  return data ?? null;
}

/**
 * Refund requests for a space — defaults to the open ('requested') queue,
 * newest first, so the seller orders page can show a count / list.
 */
export async function getRefundRequestsForSpace(
  spaceId: string,
  opts?: { status?: RefundRequestStatus },
): Promise<RefundRequestRow[]> {
  const data = (await convex().query(api.marketplace.refunds.listForSpace, {
    spaceId,
    status: opts?.status ?? undefined,
  })) as RefundRequestRow[];
  return data ?? [];
}

/** Load a single request by id, or null. Used by the seller-resolver guard. */
async function getRefundRequestById(requestId: string): Promise<RefundRequestRow | null> {
  const data = (await convex().query(api.marketplace.refunds.getById, {
    id: requestId,
  })) as RefundRequestRow | null;
  return data ?? null;
}

/**
 * Seller approves a refund request. This is the ONLY place a buyer-side request
 * turns into money movement: it calls the existing `markOrderRefunded` (which is
 * idempotent — it only acts on a 'paid' order, revokes the license, and claws
 * back commissions) and then marks the request resolved. If the request isn't
 * still open we no-op (null) — a declined/already-approved request can't be
 * re-approved, and we never double-refund.
 */
export async function approveRefundRequest(requestId: string): Promise<RefundRequestRow | null> {
  const request = await getRefundRequestById(requestId);
  if (!request || request.status !== 'requested') return null;

  // Money moves here, in orders.ts — never in this module. Safe to call even if
  // the order somehow already flipped to refunded: markOrderRefunded guards on
  // status='paid', so a stale call is a no-op rather than a second refund.
  await markOrderRefunded(request.orderId, 'Refund approved by seller');

  const data = (await convex().mutation(api.marketplace.refunds.resolve, {
    id: requestId,
    status: 'approved',
  })) as RefundRequestRow | null;
  if (!data) {
    logger.error('[refunds] approveRefundRequest update failed', { requestId });
    return null;
  }
  return data;
}

/**
 * Seller declines a refund request. No money moves — the order stays paid, the
 * license stays active. Just records the decision so the buyer sees it and the
 * order is no longer in the seller's open queue. No-op (null) if not still open.
 */
export async function declineRefundRequest(requestId: string): Promise<RefundRequestRow | null> {
  const request = await getRefundRequestById(requestId);
  if (!request || request.status !== 'requested') return null;

  const data = (await convex().mutation(api.marketplace.refunds.resolve, {
    id: requestId,
    status: 'declined',
  })) as RefundRequestRow | null;
  if (!data) {
    logger.error('[refunds] declineRefundRequest update failed', { requestId });
    return null;
  }
  return data;
}
