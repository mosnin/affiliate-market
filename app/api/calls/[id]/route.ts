/**
 * GET /api/calls/[id]?slug=<slug> — one call with transcript + summary.
 *
 * Auth: requireSpaceOwner(slug). The row is scoped to the caller's space, so a
 * caller can't read another workspace's call by guessing an id.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSpaceOwner } from '@/lib/api-auth';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  const { id } = await params;

  let data;
  try {
    data = await convex().query(api.support.calls.getByIdInSpace, { id, spaceId: space.id });
  } catch (err) {
    logger.error('[calls] get failed', {
      id,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Could not load the call.' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ call: data });
}
