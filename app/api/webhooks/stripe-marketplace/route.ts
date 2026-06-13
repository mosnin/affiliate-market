import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import {
  markOrderPaid,
  markOrderRefunded,
  getOrderByStripeSession,
  getOrderByStripeSubscription,
  getOrderByStripePaymentIntent,
  attachStripeSubscription,
  attachStripePaymentIntent,
  attachStripeCustomer,
} from '@/lib/marketplace/orders';
import { recordPaymentCommission } from '@/lib/affiliates/recurring';
import { reverseCommissionsForInvoice } from '@/lib/affiliates/reversals';
import { logger } from '@/lib/logger';

/**
 * Stripe webhook for marketplace checkouts (separate endpoint from the SaaS
 * billing webhook at /api/webhooks/stripe). Configure with
 * STRIPE_MARKETPLACE_WEBHOOK_SECRET — falls back to STRIPE_WEBHOOK_SECRET.
 *
 * checkout.session.completed → order paid, license delivered, first
 *   commission via recordConversion (inside markOrderPaid).
 * invoice.paid (subscription_cycle) → renewal commission for the referring
 *   creator, every period the customer actually pays, while the program's
 *   recurring window allows.
 */

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const inv = invoice as unknown as Record<string, unknown>;
  const direct = inv.subscription;
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object' && 'id' in direct) {
    return String((direct as { id: unknown }).id);
  }
  const parent = (inv.parent ?? {}) as Record<string, unknown>;
  const details = (parent.subscription_details ?? {}) as Record<string, unknown>;
  const sub = details.subscription;
  if (typeof sub === 'string') return sub;
  if (sub && typeof sub === 'object' && 'id' in sub) {
    return String((sub as { id: unknown }).id);
  }
  return null;
}

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
    const order = orderId
      ? await markOrderPaid(orderId)
      : await (async () => {
          // Older sessions may lack metadata — fall back to the session id.
          const bySession = await getOrderByStripeSession(session.id);
          return bySession ? markOrderPaid(bySession.id) : null;
        })();

    // Remember the subscription so renewals can find their order, and the
    // payment intent so refunds can.
    const subscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id ?? null;
    if (order && subscriptionId) {
      await attachStripeSubscription(order.id, subscriptionId);
    }
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id ?? null;
    if (order && paymentIntentId) {
      await attachStripePaymentIntent(order.id, paymentIntentId);
    }
    // Customer id powers the buyer billing portal (manage/cancel subscription).
    const customerId =
      typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
    if (order && customerId) {
      await attachStripeCustomer(order.id, customerId);
    }
  }

  if (event.type === 'invoice.paid') {
    const invoice = event.data.object as Stripe.Invoice;
    // The first invoice's money is commissioned by checkout.session.completed.
    if (invoice.billing_reason !== 'subscription_create') {
      const subscriptionId = invoiceSubscriptionId(invoice);
      const order = subscriptionId ? await getOrderByStripeSubscription(subscriptionId) : null;
      if (order && (invoice.amount_paid ?? 0) > 0) {
        await recordPaymentCommission({
          spaceId: order.spaceId,
          stripeInvoiceId: invoice.id ?? `evt_${event.id}`,
          amountCents: invoice.amount_paid ?? 0,
          currency: invoice.currency ?? order.currency,
          buyerEmail: invoice.customer_email ?? order.buyerEmail,
          referralCode: order.referralCode,
          source: 'marketplace',
          orderId: order.id,
        });
      }
    }
  }

  // The unhappy paths: money that came back claws its commission back.
  if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
    const obj = event.data.object as Stripe.Charge | Stripe.Dispute;
    const reason = event.type === 'charge.refunded' ? 'Charge refunded' : 'Charge disputed';
    const charge = (
      event.type === 'charge.dispute.created' ? (obj as Stripe.Dispute) : obj
    ) as unknown as Record<string, unknown>;

    // Subscription invoices carry the invoice id; one-time payments are
    // found via the payment intent we stored at checkout completion.
    const invoiceId =
      typeof charge.invoice === 'string'
        ? charge.invoice
        : ((charge.invoice as { id?: string } | null)?.id ?? null);
    if (invoiceId) {
      await reverseCommissionsForInvoice(invoiceId, reason);
    }

    const paymentIntentId =
      typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : ((charge.payment_intent as { id?: string } | null)?.id ?? null);
    if (paymentIntentId) {
      const order = await getOrderByStripePaymentIntent(paymentIntentId);
      if (order) await markOrderRefunded(order.id, reason);
    }
  }

  return NextResponse.json({ received: true });
}
