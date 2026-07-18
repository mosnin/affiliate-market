import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import Stripe_ from 'stripe';
import {
  getBridgeById,
  decryptBridgeSecret,
  processBridgeEvent,
} from '@/lib/affiliates/stripe-bridge';
import { logger } from '@/lib/logger';

/**
 * Per-seller Stripe bridge endpoint. The seller adds this URL as a webhook
 * in THEIR Stripe dashboard (events: invoice.paid, checkout.session.completed)
 * and pastes the signing secret into Cola. Signature verification uses that
 * per-bridge secret — no platform Stripe key required, and events from the
 * seller's account never touch the platform account.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ bridgeId: string }> },
) {
  const { bridgeId } = await params;
  const bridge = await getBridgeById(bridgeId);
  if (!bridge) return NextResponse.json({ error: 'Unknown endpoint' }, { status: 404 });

  const secret = decryptBridgeSecret(bridge);
  if (!secret) {
    return NextResponse.json({ error: 'Bridge not configured' }, { status: 409 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) return NextResponse.json({ error: 'Missing signature' }, { status: 400 });

  let event: Stripe.Event;
  try {
    const payload = await req.text();
    // Static helper — verifies against the seller's signing secret without
    // needing any API key for their account.
    event = Stripe_.webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    logger.warn('[affiliates] bridge signature verification failed', {
      bridgeId,
      err: String(err),
    });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  await processBridgeEvent(bridge, event);
  return NextResponse.json({ received: true });
}
