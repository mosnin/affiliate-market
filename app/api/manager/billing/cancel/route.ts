import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { supabase } from '@/lib/supabase';
import { getManagerContext } from '@/lib/permissions';
import { checkRateLimit } from '@/lib/rate-limit';

/**
 * Manager-scoped subscription cancel (at period end).
 *
 * Mirrors /api/billing/cancel but targets the COMPANY's subscription, not a
 * Space the caller owns. Same auth as the company checkout branch:
 * getManagerContext() + manager_owner only. The webhook keeps DB status in sync
 * when the cancellation lands.
 */
export async function POST() {
  const ctx = await getManagerContext();
  if (!ctx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (ctx.membership.role !== 'manager_owner') {
    return NextResponse.json(
      { error: 'Only the company owner can manage billing.' },
      { status: 403 },
    );
  }

  const { allowed } = await checkRateLimit(`billing:company:${ctx.dbUserId}`, 5, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  // Company subscription first; legacy owner-space subscription as fallback.
  const { data: company } = await supabase
    .from('Company')
    .select('stripeSubscriptionId')
    .eq('id', ctx.company.id)
    .maybeSingle();

  let subscriptionId = (company?.stripeSubscriptionId as string | null) ?? null;
  if (!subscriptionId) {
    const { data: ownerSpace } = await supabase
      .from('Space')
      .select('stripeSubscriptionId')
      .eq('ownerId', ctx.company.ownerId)
      .maybeSingle();
    subscriptionId = (ownerSpace?.stripeSubscriptionId as string | null) ?? null;
  }

  if (!subscriptionId) {
    return NextResponse.json({ error: 'No active subscription' }, { status: 400 });
  }

  const stripe = getStripe();

  // Cancel at end of billing period (not immediately) — same policy as the
  // seller cancel route.
  await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });

  return NextResponse.json({ ok: true });
}
