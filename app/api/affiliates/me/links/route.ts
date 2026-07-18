import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { getPartnerByUser } from '@/lib/affiliates/partners';
import { createLink } from '@/lib/affiliates/links';

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

  let destinationUrl: string | null = null;
  try {
    const body = await req.json();
    if (typeof body?.destinationUrl === 'string' && body.destinationUrl.trim()) {
      destinationUrl = body.destinationUrl.trim().slice(0, 2048);
    }
  } catch {
    // Empty body is fine — default destination.
  }

  const link = await createLink(partner.id, destinationUrl);
  if (!link) return NextResponse.json({ error: 'Could not create link' }, { status: 500 });
  return NextResponse.json({ link });
}
