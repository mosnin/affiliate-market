import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@clerk/nextjs/server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import {
  createSellerConnectOnboardingLink,
  getSellerConnectAccountId,
  sellerPayoutsConfigured,
} from '@/lib/marketplace/sellers';

/** Seller payout status: connected or not. */
export async function GET() {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const accountId = await getSellerConnectAccountId(result.space.id);
  return NextResponse.json({
    configured: sellerPayoutsConfigured(),
    connected: Boolean(accountId),
  });
}

/** Start (or resume) Stripe Connect onboarding for marketplace proceeds. */
export async function POST(req: NextRequest) {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  if (!sellerPayoutsConfigured()) {
    return NextResponse.json(
      { error: 'Stripe is not configured on this deployment yet.' },
      { status: 503 },
    );
  }

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress ?? null;
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;

  const url = await createSellerConnectOnboardingLink(
    { id: result.space.id, slug: result.space.slug },
    email,
    origin,
  );
  if (!url) return NextResponse.json({ error: 'Could not start Stripe onboarding.' }, { status: 502 });
  return NextResponse.json({ url });
}
