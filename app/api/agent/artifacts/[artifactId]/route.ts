import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';
import { checkRateLimit } from '@/lib/rate-limit';

// GET /api/agent/artifacts/[artifactId]
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const rl = await checkRateLimit(`agent:artifacts:get:${userId}`, 60, 60);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', retryAfter: undefined },
      { status: 429 },
    );
  }

  const { artifactId } = await params;

  // Fetch artifact + its versions (one mutation-free query). The artifact is
  // loaded first to derive spaceId for auth.
  let result;
  try {
    result = await convex().query(api.conversations.artifacts.getWithVersions, { id: artifactId });
  } catch (artifactError) {
    console.error('[GET /api/agent/artifacts/[artifactId]]', artifactError);
    return NextResponse.json({ error: 'Failed to fetch artifact' }, { status: 500 });
  }
  if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { artifact, versions } = result;

  // Verify space ownership
  const space = await getSpaceForUser(userId);
  if (!space || space.id !== artifact.spaceId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({ artifact: { ...artifact, versions } });
}

// PATCH /api/agent/artifacts/[artifactId]
// Body: { content: string }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const rl = await checkRateLimit(`agent:artifacts:version:${userId}`, 20, 60);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', retryAfter: undefined },
      { status: 429 },
    );
  }

  const { artifactId } = await params;

  let body: { content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { content } = body;
  if (content === undefined || content === null) {
    return NextResponse.json({ error: 'content required' }, { status: 400 });
  }

  // Fetch artifact to verify existence and derive spaceId
  let artifact;
  try {
    artifact = await convex().query(api.conversations.artifacts.getById, { id: artifactId });
  } catch (artifactError) {
    console.error('[PATCH /api/agent/artifacts/[artifactId]]', artifactError);
    return NextResponse.json({ error: 'Failed to fetch artifact' }, { status: 500 });
  }
  if (!artifact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Verify space ownership
  const space = await getSpaceForUser(userId);
  if (!space || space.id !== artifact.spaceId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // One atomic mutation replaces the old three steps (max versionNumber ->
  // insert next version -> patch currentVersionId + updatedAt).
  let result;
  try {
    result = await convex().mutation(api.conversations.artifacts.addVersion, { artifactId, content });
  } catch (versionError) {
    console.error('[PATCH /api/agent/artifacts/[artifactId]] add version error:', versionError);
    return NextResponse.json({ error: 'Failed to create new version' }, { status: 500 });
  }
  if (!result.ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ artifact: { ...result.artifact, newVersion: result.newVersion } });
}
