import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { getPartnerByUser } from '@/lib/affiliates/partners';
import { createVanityLink } from '@/lib/affiliates/links';

/**
 * Creator mints a vanity code (CASEY20) — memorable, optionally discounting.
 * Bound to the partner row for the program they pick (or their first approved
 * one). The discount is capped by createVanityLink (≤ 90%).
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress ?? null;
  const partner = await getPartnerByUser({ clerkUserId: userId, email });
  if (!partner) return NextResponse.json({ error: 'Not an affiliate' }, { status: 404 });
  if (partner.status !== 'approved') {
    return NextResponse.json({ error: 'Your application is still pending.' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const code = typeof body.code === 'string' ? body.code : '';
  const discountPercent = typeof body.discountPercent === 'number' ? body.discountPercent : 0;
  if (!code) return NextResponse.json({ error: 'Enter a code.' }, { status: 400 });

  const result = await createVanityLink(partner.id, code, { discountPercent });
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({
    link: {
      id: result.link.id,
      code: result.link.code,
      discountPercent: result.link.discountPercent,
    },
  });
}
