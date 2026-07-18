import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

type Params = { params: Promise<{ id: string }> };

// DELETE /api/mcp-keys/[id] — revoke an API key
export async function DELETE(_req: NextRequest, { params }: Params) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  const { id } = await params;

  // Ensure the key belongs to the user's space before deleting
  const existing = await convex().query(api.infra.mcpApiKeys.existsForSpace, {
    id,
    spaceId: space.id,
  });

  if (!existing)
    return NextResponse.json({ error: 'API key not found' }, { status: 404 });

  try {
    await convex().mutation(api.infra.mcpApiKeys.deleteById, { id });
  } catch {
    return NextResponse.json({ error: 'Failed to delete API key' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
