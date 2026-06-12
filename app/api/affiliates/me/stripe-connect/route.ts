import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { getPartnersByUser } from '@/lib/affiliates/partners';
import {
  createConnectOnboardingLink,
  stripeConnectConfigured,
} from '@/lib/affiliates/stripe-connect';

/** Start (or resume) Stripe Connect onboarding for the signed-in creator. */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!stripeConnectConfigured()) {
    return NextResponse.json(
      { error: 'Payouts via Stripe are not configured on this deployment yet.' },
      { status: 503 },
    );
  }

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress ?? null;
  const partners = await getPartnersByUser({ clerkUserId: userId, email });
  if (partners.length === 0) {
    return NextResponse.json({ error: 'No affiliate account found.' }, { status: 404 });
  }

  // One Stripe account per creator: reuse the first connected id if any
  // partner row already has one, otherwise onboard against the oldest row.
  const anchor = partners.find((p) => p.stripeAccountId) ?? partners[0];
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
  const url = await createConnectOnboardingLink(anchor, origin);
  if (!url) return NextResponse.json({ error: 'Could not start Stripe onboarding.' }, { status: 502 });

  return NextResponse.json({ url });
}
