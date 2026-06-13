import { NextRequest, NextResponse } from 'next/server';
import { getClientUser } from '@/lib/client-auth';
import { getStripeCustomerForBuyer } from '@/lib/marketplace/orders';
import { getStripe } from '@/lib/stripe';

/**
 * Buyer self-service: open the Stripe billing portal so the buyer can update
 * their card, view invoices, or cancel a subscription — no seller support.
 * Requires a buyer session and a subscription purchase with a Stripe customer.
 */
export async function POST(req: NextRequest) {
  const user = await getClientUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Subscription management isn’t enabled here.' }, { status: 503 });
  }

  const customerId = await getStripeCustomerForBuyer(user.email);
  if (!customerId) {
    return NextResponse.json({ error: 'No subscription found for your account.' }, { status: 404 });
  }

  try {
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
    const portal = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin.replace(/\/$/, '')}/buyer/dashboard`,
    });
    return NextResponse.json({ url: portal.url });
  } catch {
    return NextResponse.json({ error: 'Could not open billing. Try again.' }, { status: 502 });
  }
}
