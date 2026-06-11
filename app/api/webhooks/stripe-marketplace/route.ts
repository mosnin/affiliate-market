import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { markOrderPaid, getOrderByStripeSession } from '@/lib/marketplace/orders';
import { logger } from '@/lib/logger';

/**
 * Stripe webhook for marketplace checkouts (separate endpoint from the SaaS
 * billing webhook at /api/webhooks/stripe). Configure with
 * STRIPE_MARKETPLACE_WEBHOOK_SECRET — falls back to STRIPE_WEBHOOK_SECRET.
 */
export async function POST(req: NextRequest) {
  const secret =
    process.env.STRIPE_MARKETPLACE_WEBHOOK_SECRET ?? process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers.get('stripe-signature');
  if (!secret || !signature) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const payload = await req.text();
    event = getStripe().webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    logger.warn('[marketplace] webhook signature verification failed', { err: String(err) });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const orderId = session.metadata?.orderId;
    if (orderId) {
      await markOrderPaid(orderId);
    } else {
      // Older sessions may lack metadata — fall back to the session id.
      const order = await getOrderByStripeSession(session.id);
      if (order) await markOrderPaid(order.id);
    }
  }

  return NextResponse.json({ received: true });
}
