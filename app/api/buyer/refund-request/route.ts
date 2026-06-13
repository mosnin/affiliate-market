import { NextRequest, NextResponse } from 'next/server';
import { getClientUser } from '@/lib/client-auth';
import { createRefundRequest } from '@/lib/marketplace/refunds';

/**
 * Buyer files a refund request on one of their paid orders. The data layer does
 * the real work — ownership + paid + one-open-request guards, spaceId taken from
 * the order. We just auth the buyer, pass the body through, and map the
 * discriminated result to an HTTP status the form can react to.
 */
export async function POST(req: NextRequest) {
  const user = await getClientUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { orderId?: string; reason?: string } | null;
  const orderId = body?.orderId?.trim();
  if (!orderId) return NextResponse.json({ error: 'Missing order.' }, { status: 400 });

  const result = await createRefundRequest({
    orderId,
    buyerEmail: user.email,
    reason: body?.reason ?? null,
  });

  if (result.ok) return NextResponse.json({ ok: true });

  switch (result.error) {
    case 'not_found':
      return NextResponse.json({ error: "We couldn't find that order." }, { status: 404 });
    case 'not_owner':
      return NextResponse.json({ error: "That order isn't on your account." }, { status: 403 });
    case 'not_paid':
      return NextResponse.json({ error: 'Only a paid order can be refunded.' }, { status: 409 });
    case 'already_requested':
      return NextResponse.json(
        { error: "You've already requested a refund on this order." },
        { status: 409 },
      );
  }
}
