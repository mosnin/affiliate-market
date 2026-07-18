import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

async function resolveProfile(userId: string, profileId: string) {
  const row = await convex().query(api.demos.profiles.getById, { id: profileId });
  if (!row) return null;
  const space = await getSpaceForUser(userId);
  if (!space || row.spaceId !== space.id) return null;
  return { profile: row, space };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const { id } = await params;

  const ctx = await resolveProfile(userId, id);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json();
  const data = await convex().mutation(api.demos.profiles.updateById, {
    id,
    spaceId: ctx.space.id,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.address !== undefined ? { address: body.address || null } : {}),
    ...(body.demoDuration !== undefined ? { demoDuration: body.demoDuration } : {}),
    ...(body.startHour !== undefined ? { startHour: body.startHour } : {}),
    ...(body.endHour !== undefined ? { endHour: body.endHour } : {}),
    ...(body.daysAvailable !== undefined ? { daysAvailable: body.daysAvailable } : {}),
    ...(body.bufferMinutes !== undefined ? { bufferMinutes: body.bufferMinutes } : {}),
    ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
  });

  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const { id } = await params;

  const ctx = await resolveProfile(userId, id);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await convex().mutation(api.demos.profiles.deleteById, { id, spaceId: ctx.space.id });

  return NextResponse.json({ success: true });
}
