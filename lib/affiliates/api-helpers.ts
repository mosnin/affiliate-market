import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';
import type { Space } from '@/lib/types';

/**
 * Seller-scoped affiliate routes resolve the caller's own space — no slug in
 * the URL, so a seller can only ever manage their own program.
 */
export async function requireSellerSpace(): Promise<
  { userId: string; space: Space } | NextResponse
> {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  const space = await getSpaceForUser(authResult.userId);
  if (!space) {
    return NextResponse.json({ error: 'No workspace found' }, { status: 404 });
  }
  return { userId: authResult.userId, space };
}
