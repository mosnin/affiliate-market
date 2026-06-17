/**
 * GET /api/studio/recent-job — the most recent in-flight or just-finished
 * Studio job for the seller's space.
 *
 * Studio generation is synchronous (the route holds the connection open until
 * fal returns), so a refresh / nav / tab-close mid-job used to lose the result
 * — the seller paid $0.50 for a seedance-video and saw a black hole. The
 * StudioGeneration row is the source of truth; the Create / Edit panels poll
 * this endpoint on mount to pick the job back up.
 *
 * Query params:
 *   source='create' — only generations with no sourceFileId (fresh prompts).
 *   source='edit'   — only generations with a sourceFileId (transforms).
 *   anything else   — no filter (latest job of any kind).
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';
import { convex, api } from '@/lib/convex-server';
import { getSignedDownloadUrl } from '@/lib/storage';

export const runtime = 'nodejs';

// A job older than this that is still 'running' is presumed orphaned (the
// lambda died mid-call before recording completion). Treat as no job so the
// spinner can never wedge a panel forever.
const RUNNING_MAX_AGE_S = 600;

/** The latest generation for a space, optionally scoped to create/edit jobs. */
function recentJobQuery(spaceId: string, source: 'create' | 'edit' | undefined) {
  return convex().query(api.studio.generations.recentJob, { spaceId, source });
}

export async function GET(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const space = await getSpaceForUser(auth.userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const url = new URL(req.url);
  const source = url.searchParams.get('source');

  const sourceFilter = source === 'create' || source === 'edit' ? source : undefined;
  let data: Awaited<ReturnType<typeof recentJobQuery>>;
  try {
    data = await recentJobQuery(space.id, sourceFilter);
  } catch {
    return NextResponse.json({ job: null });
  }
  if (!data) return NextResponse.json({ job: null });

  const ageS = (Date.now() - new Date(data.createdAt).getTime()) / 1000;
  const status = data.status;
  const kind: 'image' | 'video' = data.kind === 'video' ? 'video' : 'image';

  if (status === 'running') {
    if (ageS > RUNNING_MAX_AGE_S) {
      // Presumed orphaned; don't trap the panel in a permanent spinner.
      return NextResponse.json({ job: null });
    }
    return NextResponse.json({
      job: { id: data.id, status: 'running', kind },
    });
  }

  if (status === 'completed' && data.fileId) {
    const file = await convex().query(api.infra.files.getByIdForSpace, {
      id: data.fileId as string,
      spaceId: space.id,
    });
    if (file?.storageKey) {
      const downloadUrl = await getSignedDownloadUrl(file.storageKey as string, 3600);
      return NextResponse.json({
        job: {
          id: data.id,
          status: 'completed',
          kind,
          fileId: data.fileId,
          url: downloadUrl,
        },
      });
    }
  }

  if (status === 'failed') {
    return NextResponse.json({
      job: {
        id: data.id,
        status: 'failed',
        kind,
        errorMessage: (data.errorMessage as string | null) ?? undefined,
      },
    });
  }

  return NextResponse.json({ job: null });
}
