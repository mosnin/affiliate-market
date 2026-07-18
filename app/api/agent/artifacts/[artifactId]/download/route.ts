import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

// MIME type + file extension for each artifact type
function getMimeAndExt(artifactType: string): { mime: string; ext: string } {
  switch (artifactType) {
    case 'draft_email':
    case 'draft_sms':
    case 'raw_output':
    case 'contact_update':
    case 'deal_update':
    case 'demo_booking':
    case 'goal_plan':
      return { mime: 'text/plain', ext: 'txt' };
    case 'report':
      return { mime: 'text/markdown', ext: 'md' };
    default:
      return { mime: 'application/octet-stream', ext: 'bin' };
  }
}

// GET /api/agent/artifacts/[artifactId]/download?version=N
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const { artifactId } = await params;
  const versionParam = req.nextUrl.searchParams.get('version');

  // 1. Fetch artifact (for title/type/ownership; spaceId drives the auth check)
  let artifact;
  try {
    artifact = await convex().query(api.conversations.artifacts.getById, { id: artifactId });
  } catch (artifactError) {
    console.error('[GET /api/agent/artifacts/[artifactId]/download] artifact fetch:', artifactError);
    return NextResponse.json({ error: 'Failed to fetch artifact' }, { status: 500 });
  }
  // Return 404 regardless of whether artifact doesn't exist or belongs to another tenant —
  // avoids confirming artifact existence to cross-tenant callers.
  if (!artifact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // 2. Ownership check — cross-tenant returns 404, not 403, to avoid leaking existence
  const space = await getSpaceForUser(userId);
  if (!space || space.id !== artifact.spaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // 3. Resolve the target ArtifactVersion. Precedence (unchanged): explicit
  // ?version=N -> currentVersionId -> highest versionNumber.
  let parsedVersionNumber: number | undefined;
  if (versionParam !== null) {
    const versionNumber = parseInt(versionParam, 10);
    if (isNaN(versionNumber) || versionNumber < 1) {
      return NextResponse.json({ error: 'Invalid version number' }, { status: 400 });
    }
    parsedVersionNumber = versionNumber;
  }

  let version;
  try {
    version = await convex().query(api.conversations.artifacts.versionForDownload, {
      artifactId,
      ...(parsedVersionNumber !== undefined ? { versionNumber: parsedVersionNumber } : {}),
      ...(parsedVersionNumber === undefined && artifact.currentVersionId
        ? { currentVersionId: artifact.currentVersionId }
        : {}),
    });
  } catch (versionError) {
    console.error('[GET /api/agent/artifacts/[artifactId]/download] version fetch:', versionError);
    return NextResponse.json({ error: 'Failed to fetch artifact version' }, { status: 500 });
  }
  if (!version) return NextResponse.json({ error: 'Version not found' }, { status: 404 });

  // 4. Build response with correct MIME type and Content-Disposition
  const { mime, ext } = getMimeAndExt(artifact.artifactType ?? '');
  const safeTitle = (artifact.title ?? 'artifact').replace(/[^a-zA-Z0-9_\-. ]/g, '_');
  const filename = `${safeTitle}-v${version.versionNumber}.${ext}`;

  return new Response(version.content, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
