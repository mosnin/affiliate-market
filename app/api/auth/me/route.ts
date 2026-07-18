import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { convex, api } from '@/lib/convex-server';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await convex().query(api.org.users.getByClerkId, { clerkId: userId });
  if (!user) return NextResponse.json({ slug: null });

  const space = await convex().query(api.workspace.spaces.getByOwnerId, { ownerId: user.id });

  return NextResponse.json({ slug: space?.slug ?? null });
}
