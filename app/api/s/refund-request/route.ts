import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';
import { approveRefundRequest, declineRefundRequest } from '@/lib/marketplace/refunds';

/**
 * Seller resolves a buyer's refund request: approve (which triggers the actual
 * refund via markOrderRefunded) or decline (no money moves).
 *
 * The ownership guard is the whole point of this route. We never trust the
 * client's requestId — we load the request, read its denormalised spaceId, and
 * confirm it matches the space the signed-in seller owns before acting. Without
 * that, anyone with a session could refund another workspace's orders.
 */
export async function POST(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const body = (await req.json().catch(() => null)) as
    | { requestId?: string; action?: 'approve' | 'decline' }
    | null;
  const requestId = body?.requestId?.trim();
  const action = body?.action;
  if (!requestId || (action !== 'approve' && action !== 'decline')) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Load the request and verify it belongs to this seller's space. 404 (not 403)
  // when it isn't theirs — don't confirm the existence of another space's request.
  const request = await convex().query(api.marketplace.refunds.getById, { id: requestId });
  if (!request || request.spaceId !== space.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const updated =
    action === 'approve'
      ? await approveRefundRequest(requestId)
      : await declineRefundRequest(requestId);

  // null means the request was no longer open (already resolved or a race).
  if (!updated) {
    return NextResponse.json({ error: 'That request was already resolved.' }, { status: 409 });
  }

  return NextResponse.json({ ok: true, status: updated.status });
}
