import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { getSpaceForUser } from '@/lib/space';
import { requireAuth } from '@/lib/api-auth';
import { logger } from '@/lib/logger';
import { deleteObjectsBestEffort, publicUrlToKey } from '@/lib/storage';
import { _sanitiseProductBody as sanitise } from '@/app/api/products/route';

async function resolve(userId: string, id: string) {
  const space = await getSpaceForUser(userId);
  if (!space) return null;
  const data = await convex().query(api.marketplace.products.getByIdInSpace, {
    id,
    spaceId: space.id,
  });
  if (!data) return null;
  return { space, product: data };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const { id } = await params;
  const ctx = await resolve(userId, id);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Include linked deals + demos so the detail page can show usage.
  const [dealsResult, demos] = await Promise.all([
    supabase
      .from('Deal')
      .select('id, title, status, value, closeDate, stageId')
      .eq('productId', id)
      .eq('spaceId', ctx.space.id)
      .order('updatedAt', { ascending: false })
      .limit(20),
    convex().query(api.demos.demos.listByProduct, {
      productId: id,
      spaceId: ctx.space.id,
      limit: 20,
    }),
  ]);

  return NextResponse.json({
    ...ctx.product,
    deals: dealsResult.data ?? [],
    demos,
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const { id } = await params;
  const ctx = await resolve(userId, id);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const { out, errors } = sanitise(body, 'update');
  if (errors.length) return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  if (Object.keys(out).length === 0) return NextResponse.json(ctx.product);

  // `out` is the sanitised writable bag; the mutation bumps updatedAt itself.
  const result = await convex().mutation(api.marketplace.products.update, {
    id,
    spaceId: ctx.space.id,
    fields: out,
  });

  if (!result.ok) {
    if (result.error === 'duplicate_mls' || result.error === 'duplicate_slug') {
      return NextResponse.json({ error: 'A product with that MLS number already exists' }, { status: 409 });
    }
    if (result.error === 'not_found') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    logger.error('[products/PATCH] update failed', { productId: id, error: result.error });
    return NextResponse.json({ error: 'Failed to update product' }, { status: 500 });
  }
  return NextResponse.json(result.product);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const { id } = await params;
  const ctx = await resolve(userId, id);
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Cascades this domain's child rows (License/MarketplaceOrder/RefundRequest/
  // ProductPacket/ProductView/Review) and returns the deleted product's photos.
  const removed = await convex().mutation(api.marketplace.products.remove, {
    id,
    spaceId: ctx.space.id,
  });
  if (!removed.ok) {
    logger.error('[products/DELETE] failed', { productId: id });
    return NextResponse.json({ error: 'Failed to delete product' }, { status: 500 });
  }

  // Deal/Demo `productId` ON DELETE SET NULL is cross-backend. Deal stays on
  // Supabase; Demo is on Convex now. Null the link explicitly on each so the
  // deal/demo survives with its string address intact, link gone.
  await Promise.all([
    supabase.from('Deal').update({ productId: null }).eq('productId', id),
    convex().mutation(api.demos.demos.clearProductId, { productId: id }),
  ]);

  // `photos` is a JSONB array of public URLs (legacy schema decision). Reverse
  // each URL back to a Wasabi key so we can clean up the bucket — otherwise
  // listing photos for sold products survive forever in storage, EXIF and all.
  const rawPhotos = removed.photos;
  const photoUrls = Array.isArray(rawPhotos)
    ? rawPhotos.filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];
  const photoKeys = photoUrls
    .map((u) => publicUrlToKey(u))
    .filter((k): k is string => Boolean(k));

  // Fire-and-forget the photo cleanup. Storage failure here orphans the
  // object; the nightly storage-gc sweeper catches it on its next pass.
  if (photoKeys.length > 0) {
    void deleteObjectsBestEffort(photoKeys).then((res) => {
      if (res.failed.length > 0) {
        logger.warn('[products/DELETE] some photos failed to delete', {
          productId: id,
          spaceId: ctx.space.id,
          okCount: res.ok,
          failedCount: res.failed.length,
        });
      }
    });
  }

  return NextResponse.json({ ok: true });
}
