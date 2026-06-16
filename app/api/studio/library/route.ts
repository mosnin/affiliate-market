/**
 * GET /api/studio/library — the seller's recent Studio generations, newest
 * first, each with a signed URL to its asset.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { getSignedDownloadUrl } from '@/lib/storage';

export const runtime = 'nodejs';

const PAGE_SIZE = 60;

export async function GET(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const space = await getSpaceForUser(auth.userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const url = new URL(req.url);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);

  let rows: Array<{
    id: string;
    kind: string;
    model: string;
    prompt: string | null;
    fileId: string;
    createdAt: string;
  }>;
  try {
    rows = await convex().query(api.studio.generations.library, {
      spaceId: space.id,
      offset,
      pageSize: PAGE_SIZE,
    });
  } catch (error) {
    logger.error('[studio.library] query failed', { spaceId: space.id }, error as Error);
    return NextResponse.json({ error: 'Could not load your library.' }, { status: 500 });
  }

  // Resolve a signed URL per asset. S3 presigning is local (no network call),
  // so signing the whole page is cheap.
  const { data: files, error: filesErr } = await supabase
    .from('File')
    .select('id, storageKey')
    .in('id', rows.map((r) => r.fileId));
  if (filesErr) {
    // Log loudly — silently returning null URLs for every item is worse than
    // surfacing the failure to the operator. Items still render with null
    // URLs (placeholder tiles) so the page doesn't blank out.
    logger.error('[studio.library] files query failed', { spaceId: space.id }, filesErr);
  }
  const keyById = new Map(
    ((files ?? []) as Array<{ id: string; storageKey: string }>).map((f) => [
      f.id,
      f.storageKey,
    ]),
  );

  const items = await Promise.all(
    rows.map(async (r) => {
      const key = keyById.get(r.fileId);
      return {
        id: r.id,
        kind: r.kind,
        model: r.model,
        prompt: r.prompt ?? '',
        fileId: r.fileId,
        createdAt: r.createdAt,
        url: key ? await getSignedDownloadUrl(key, 3600) : null,
      };
    }),
  );

  const nextOffset = items.length === PAGE_SIZE ? offset + PAGE_SIZE : null;
  return NextResponse.json({ items, nextOffset });
}
