import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { getCreatorProfileByEmail, upsertCreatorProfile } from '@/lib/affiliates/creators';

/** The signed-in creator's own discovery profile. */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress ?? null;
  if (!email) return NextResponse.json({ profile: null });

  const profile = await getCreatorProfileByEmail(email);
  return NextResponse.json({ profile });
}

export async function PATCH(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress ?? null;
  if (!email) return NextResponse.json({ error: 'Your account has no email.' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const fallbackName =
    [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || email.split('@')[0];

  const profile = await upsertCreatorProfile({
    email,
    clerkUserId: userId,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : fallbackName,
    bio: typeof body.bio === 'string' ? body.bio : undefined,
    niche: typeof body.niche === 'string' ? body.niche : undefined,
    audienceSize: typeof body.audienceSize === 'number' ? body.audienceSize : undefined,
    channels: Array.isArray(body.channels) ? (body.channels as string[]) : undefined,
    websiteUrl: typeof body.websiteUrl === 'string' ? body.websiteUrl : undefined,
    listed: typeof body.listed === 'boolean' ? body.listed : undefined,
  });
  if (!profile) return NextResponse.json({ error: 'Could not save your profile.' }, { status: 500 });
  return NextResponse.json({ profile });
}
