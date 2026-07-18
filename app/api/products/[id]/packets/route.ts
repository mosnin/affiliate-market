import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { getSpaceForUser } from '@/lib/space';
import { requireAuth } from '@/lib/api-auth';
import { logger } from '@/lib/logger';

async function resolve(userId: string, productId: string) {
  const space = await getSpaceForUser(userId);
  if (!space) return null;
  const product = await convex().query(api.marketplace.products.getByIdInSpace, {
    id: productId,
    spaceId: space.id,
  });
  if (!product) return null;
  return space;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const { id } = await params;
  const space = await resolve(userId, id);
  if (!space) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const data = await convex().query(api.marketplace.packets.listForProductInSpace, {
      productId: id,
      spaceId: space.id,
    });
    return NextResponse.json(data ?? []);
  } catch (error) {
    logger.error('[packets/GET]', { productId: id }, error as Error);
    return NextResponse.json({ error: 'Failed to list packets' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const { id } = await params;
  const space = await resolve(userId, id);
  if (!space) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  if (!name) return NextResponse.json({ error: 'Name required' }, { status: 400 });

  // Default expiry: 7 days. Pass null to make it permanent (not recommended
  // but allowed for internal sharing).
  let expiresAt: string | null = null;
  if (body.expiresAt === null) {
    expiresAt = null;
  } else if (body.expiresAt) {
    const d = new Date(body.expiresAt as string);
    if (isNaN(d.getTime())) return NextResponse.json({ error: 'Invalid expiresAt' }, { status: 400 });
    expiresAt = d.toISOString();
  } else {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    expiresAt = d.toISOString();
  }

  // Validate every documentId actually belongs to the caller's space. Otherwise
  // a malicious client could trick the packet page into signing URLs for
  // documents it doesn't own.
  const includeIds = Array.isArray(body.includeDocumentIds)
    ? (body.includeDocumentIds as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 50)
    : [];
  if (includeIds.length > 0) {
    const { data: docs } = await supabase
      .from('DealDocument')
      .select('id')
      .in('id', includeIds)
      .eq('spaceId', space.id);
    const validIds = new Set((docs ?? []).map((r) => r.id as string));
    for (const id of includeIds) {
      if (!validIds.has(id)) {
        return NextResponse.json({ error: 'Unknown document id' }, { status: 400 });
      }
    }
  }

  // Token: 32 bytes URL-safe = 43 chars base64url, plenty of entropy.
  const token = crypto.randomBytes(32).toString('base64url');

  try {
    const data = await convex().mutation(api.marketplace.packets.create, {
      id: crypto.randomUUID(),
      spaceId: space.id,
      productId: id,
      name,
      token,
      includeDocumentIds: includeIds,
      expiresAt,
    });
    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    logger.error('[packets/POST]', { productId: id }, error as Error);
    return NextResponse.json({ error: 'Failed to create packet' }, { status: 500 });
  }
}
