import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { convex, api } from '@/lib/convex-server';
import { getManagerContext } from '@/lib/permissions';
import { checkRateLimit } from '@/lib/rate-limit';

/**
 * Manager-scoped Stripe Billing Portal session.
 *
 * The seller portal route (/api/billing/portal) is keyed to a Space the caller
 * OWNS — a manager managing the company subscription needs the COMPANY's
 * Stripe customer instead. Auth mirrors the company checkout branch:
 * getManagerContext() + manager_owner only.
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

  // Prefer the Company's own Stripe customer (company-scoped checkout writes
  // it). Legacy companies that subscribed through the owner's personal Space
  // fall back to that customer so the portal still opens for them.
  let company: { stripeCustomerId: string | null } | null = null;
  try {
    company = await convex().query(api.org.companies.getById, { id: ctx.company.id });
  } catch {
    company = null;
  }

  let customerId = (company?.stripeCustomerId as string | null) ?? null;
  if (!customerId) {
    let ownerSpace: { stripeCustomerId: string | null } | null = null;
    try {
      ownerSpace = await convex().query(api.workspace.spaces.getByOwnerId, {
        ownerId: ctx.company.ownerId,
      });
    } catch {
      ownerSpace = null;
    }
    customerId = (ownerSpace?.stripeCustomerId as string | null) ?? null;
  }

  if (!customerId) {
    return NextResponse.json(
      { error: 'No billing account found. Subscribe first.' },
      { status: 400 },
    );
  }

  const stripe = getStripe();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://my.usecola.com';

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl}/manager/billing`,
  });

  return NextResponse.json({ url: session.url });
}
