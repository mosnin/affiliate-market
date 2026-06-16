import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { getSpaceForUser } from '@/lib/space';
import { requireAuth } from '@/lib/api-auth';
import { logger } from '@/lib/logger';

async function resolve(userId: string, productId: string, packetId: string) {
  const space = await getSpaceForUser(userId);
  if (!space) return null;
  const data = await convex().query(api.marketplace.packets.getByIdScoped, {
    id: packetId,
    spaceId: space.id,
    productId,
  });
  if (!data) return null;
  return { space, packet: data };
}

/** Revoke or update a packet. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; packetId: string }> },
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const { id, packetId } = await params;
  const ctx = await resolve(userId, id, packetId);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  // Tri-state patch mirrored onto the Convex mutation args:
  //   revoked  → set/clear revokedAt (omit to leave)
  //   name     → set (validated non-empty)
  //   expiresAt→ undefined leave / null clear / string set
  const patchArgs: {
    id: string;
    spaceId: string;
    revoked?: boolean;
    name?: string;
    expiresAt?: string | null;
  } = { id: packetId, spaceId: ctx.space.id };
  let hasPatch = false;

  if (body.revoked === true || body.revoked === false) {
    patchArgs.revoked = body.revoked;
    hasPatch = true;
  }

  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 200);
    if (!name) return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
    patchArgs.name = name;
    hasPatch = true;
  }

  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null) patchArgs.expiresAt = null;
    else {
      const d = new Date(body.expiresAt as string);
      if (isNaN(d.getTime())) return NextResponse.json({ error: 'Invalid expiresAt' }, { status: 400 });
      patchArgs.expiresAt = d.toISOString();
    }
    hasPatch = true;
  }

  if (!hasPatch) return NextResponse.json(ctx.packet);

  try {
    const data = await convex().mutation(api.marketplace.packets.update, patchArgs);
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(data);
  } catch (error) {
    logger.error('[packets/PATCH]', { packetId }, error as Error);
    return NextResponse.json({ error: 'Failed to update packet' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; packetId: string }> },
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const { id, packetId } = await params;
  const ctx = await resolve(userId, id, packetId);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    await convex().mutation(api.marketplace.packets.remove, {
      id: packetId,
      spaceId: ctx.space.id,
    });
  } catch (error) {
    logger.error('[packets/DELETE]', { packetId }, error as Error);
    return NextResponse.json({ error: 'Failed to delete packet' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
