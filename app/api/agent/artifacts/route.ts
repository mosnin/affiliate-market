import { NextRequest, NextResponse } from 'next/server';
import type { FunctionArgs } from 'convex/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';
import { checkRateLimit } from '@/lib/rate-limit';
import { assertSpaceEnabled } from '@/lib/agent/kill-switch';

// GET /api/agent/artifacts?spaceId=xxx[&taskId=yyy][&type=zzz]
export async function GET(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const rl = await checkRateLimit(`agent:artifacts:list:${userId}`, 60, 60);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', retryAfter: undefined },
      { status: 429 },
    );
  }

  const spaceId = req.nextUrl.searchParams.get('spaceId');
  if (!spaceId) return NextResponse.json({ error: 'spaceId required' }, { status: 400 });

  const space = await getSpaceForUser(userId);
  if (!space || space.id !== spaceId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    await assertSpaceEnabled(spaceId);
  } catch {
    return NextResponse.json({ error: 'Space is disabled' }, { status: 403 });
  }

  const taskId = req.nextUrl.searchParams.get('taskId');
  const type = req.nextUrl.searchParams.get('type');

  // The optional filters mirror the old conditional `.eq('taskId')` /
  // `.eq('artifactType', type)`. artifactType is a literal union in Convex; the
  // querystring is cast to it (a bogus value simply matches nothing, as before).
  const listArgs: FunctionArgs<typeof api.conversations.artifacts.listForSpace> = { spaceId };
  if (taskId) listArgs.taskId = taskId;
  if (type) listArgs.artifactType = type as NonNullable<typeof listArgs.artifactType>;

  let artifacts;
  try {
    artifacts = await convex().query(api.conversations.artifacts.listForSpace, listArgs);
  } catch (error) {
    console.error('[GET /api/agent/artifacts]', error);
    return NextResponse.json({ error: 'Failed to fetch artifacts' }, { status: 500 });
  }

  return NextResponse.json({ artifacts });
}

// POST /api/agent/artifacts
// Body: { spaceId, taskId?, type, title, content }
export async function POST(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const rl = await checkRateLimit(`agent:artifacts:create:${userId}`, 20, 60);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', retryAfter: undefined },
      { status: 429 },
    );
  }

  let body: { spaceId?: string; taskId?: string; type?: string; title?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { spaceId, taskId, type, title, content } = body;

  if (!spaceId) return NextResponse.json({ error: 'spaceId required' }, { status: 400 });
  if (!type) return NextResponse.json({ error: 'type required' }, { status: 400 });
  if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 });
  if (content === undefined || content === null) {
    return NextResponse.json({ error: 'content required' }, { status: 400 });
  }

  const space = await getSpaceForUser(userId);
  if (!space || space.id !== spaceId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    await assertSpaceEnabled(spaceId);
  } catch {
    return NextResponse.json({ error: 'Space is disabled' }, { status: 403 });
  }

  // One atomic mutation replaces the old three round-trips (insert Artifact ->
  // insert ArtifactVersion v1 -> patch currentVersionId). artifactType is a
  // literal union in Convex; the request body's `type` is cast to it.
  const createArgs: FunctionArgs<typeof api.conversations.artifacts.create> = {
    spaceId,
    artifactType: type as FunctionArgs<typeof api.conversations.artifacts.create>['artifactType'],
    title,
    content,
  };
  if (taskId) createArgs.taskId = taskId;

  let result;
  try {
    result = await convex().mutation(api.conversations.artifacts.create, createArgs);
  } catch (createError) {
    console.error('[POST /api/agent/artifacts] create error:', createError);
    return NextResponse.json({ error: 'Failed to create artifact' }, { status: 500 });
  }

  return NextResponse.json(
    { artifact: { ...result.artifact, currentVersion: result.currentVersion } },
    { status: 201 },
  );
}
