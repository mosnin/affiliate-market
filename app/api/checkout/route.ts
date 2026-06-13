import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { supabase } from '@/lib/supabase';
import { getStripe } from '@/lib/stripe';
import { REF_COOKIE } from '@/lib/affiliates/tracking';
import { getLinkByCode, normalizeVanityCode } from '@/lib/affiliates/links';
import {
  createPendingOrder,
  attachStripeSession,
  markOrderPaid,
} from '@/lib/marketplace/orders';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * Public guest checkout for marketplace products.
 *
 * With STRIPE_SECRET_KEY: creates a Stripe Checkout Session (one-time or
 * subscription per the product's pricing model); the webhook marks the order
 * paid. Without Stripe (local/dev): the order is marked paid immediately and
 * the buyer goes straight to the success page — full flow, no card.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const { allowed } = await checkRateLimit(`checkout:${ip}`, 10, 60);
  if (!allowed) {
    return NextResponse.json({ error: 'Too many attempts. Try again shortly.' }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const productId = typeof body.productId === 'string' ? body.productId : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!productId || !email || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  }

  const { data: product } = await supabase
    .from('Product')
    .select(
      'id, spaceId, name, address, priceCents, currency, pricingModel, billingPeriod, published, marketplaceSlug',
    )
    .eq('id', productId)
    .maybeSingle();

  if (!product || !product.published) {
    return NextResponse.json({ error: 'Product not available.' }, { status: 404 });
  }
  if (product.priceCents == null || product.priceCents <= 0) {
    return NextResponse.json(
      { error: 'This product is not priced for self-serve checkout — contact the seller.' },
      { status: 400 },
    );
  }

  // Attribution: an explicit typed coupon code wins over the cookie (the
  // buyer chose it, and it carries the discount). Fall back to the cookie.
  const cookieStore = await cookies();
  const typedCode = typeof body.couponCode === 'string' ? normalizeVanityCode(body.couponCode) : null;
  const cookieCode = cookieStore.get(REF_COOKIE)?.value ?? null;

  // Resolve the discount from whichever code we end up using.
  let referralCode = typedCode ?? cookieCode;
  let discountCents = 0;
  if (referralCode) {
    const link = await getLinkByCode(referralCode);
    if (!link) {
      // A typed code that doesn't resolve is a buyer error worth surfacing;
      // a stale cookie code is just ignored.
      if (typedCode) {
        return NextResponse.json({ error: 'That code isn’t valid.' }, { status: 400 });
      }
      referralCode = null;
    } else if (link.discountPercent > 0) {
      discountCents = Math.floor((product.priceCents * link.discountPercent) / 100);
    }
  }
  const chargeCents = Math.max(0, product.priceCents - discountCents);
  if (chargeCents <= 0) {
    return NextResponse.json({ error: 'That code can’t be applied to this product.' }, { status: 400 });
  }

  const order = await createPendingOrder({
    spaceId: product.spaceId,
    productId: product.id,
    buyerEmail: email,
    amountCents: chargeCents,
    currency: product.currency ?? 'usd',
    referralCode,
    discountCents,
  });
  if (!order) {
    return NextResponse.json({ error: 'Could not start checkout.' }, { status: 500 });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin).replace(/\/$/, '');
  const successUrl = `${appUrl}/marketplace/checkout/success?orderId=${order.id}`;

  // Mock mode: no Stripe configured — complete the purchase immediately.
  if (!process.env.STRIPE_SECRET_KEY) {
    await markOrderPaid(order.id);
    return NextResponse.json({ url: successUrl });
  }

  try {
    const stripe = getStripe();
    const productName = product.name ?? product.address ?? 'Software product';
    const isSubscription = product.pricingModel === 'subscription';

    const session = await stripe.checkout.sessions.create({
      mode: isSubscription ? 'subscription' : 'payment',
      customer_email: email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: product.currency ?? 'usd',
            unit_amount: chargeCents,
            product_data: { name: productName },
            ...(isSubscription
              ? {
                  recurring: {
                    interval: product.billingPeriod === 'yearly' ? 'year' : 'month',
                  },
                }
              : {}),
          },
        },
      ],
      metadata: { orderId: order.id },
      success_url: `${successUrl}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/marketplace/p/${product.marketplaceSlug ?? ''}`,
    });

    if (!session.url) {
      return NextResponse.json({ error: 'Stripe did not return a checkout URL.' }, { status: 502 });
    }
    await attachStripeSession(order.id, session.id);
    return NextResponse.json({ url: session.url });
  } catch (err) {
    logger.error('[checkout] stripe session failed', { orderId: order.id, err: String(err) });
    return NextResponse.json({ error: 'Payment provider error. Try again.' }, { status: 502 });
  }
}
