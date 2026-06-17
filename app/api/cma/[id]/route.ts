/**
 * A single CMA report (seller-facing) — GET / PATCH / DELETE
 *
 *   GET    ?slug=<slug>            → { report }   full report incl. payload
 *   PATCH  { slug, status?, title? } → { report } publish / rename
 *   DELETE ?slug=<slug>            → { ok: true } remove the report
 *
 * Auth: requireSpaceOwner(slug). Every query is scoped by spaceId so a caller
 * can only touch reports in a workspace they own.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSpaceOwner } from '@/lib/api-auth';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const TITLE_MAX = 200;

type Params = { params: Promise<{ id: string }> };

// ── GET — one report ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  let data;
  try {
    data = await convex().query(api.portal.cmaReports.getByIdForSpace, { id, spaceId: space.id });
  } catch (err) {
    logger.error('[cma] get failed', {
      spaceId: space.id,
      id,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Could not load the report.' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  return NextResponse.json({ report: data });
}

// ── PATCH — publish / rename ──────────────────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;

  let body: { slug?: string; status?: string; title?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const slug = body.slug?.trim();
  if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  const patch: { status?: 'draft' | 'published'; title?: string | null } = {};

  if ('status' in body) {
    if (body.status !== 'draft' && body.status !== 'published') {
      return NextResponse.json({ error: 'Invalid status.' }, { status: 400 });
    }
    patch.status = body.status;
  }
  if ('title' in body) {
    patch.title =
      typeof body.title === 'string' && body.title.trim()
        ? body.title.trim().slice(0, TITLE_MAX)
        : null;
  }

  // Nothing provided → nothing to do (the mutation always bumps updatedAt, so an
  // empty patch would be a no-op write; reject it as before).
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
  }

  let data;
  try {
    data = await convex().mutation(api.portal.cmaReports.patchForSpace, {
      id,
      spaceId: space.id,
      ...patch,
    });
  } catch (err) {
    logger.error('[cma] patch failed', {
      spaceId: space.id,
      id,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Could not update the report.' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  return NextResponse.json({ report: data });
}

// ── DELETE — remove the report ────────────────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  try {
    await convex().mutation(api.portal.cmaReports.deleteForSpace, { id, spaceId: space.id });
  } catch (err) {
    logger.error('[cma] delete failed', {
      spaceId: space.id,
      id,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Could not delete the report.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
