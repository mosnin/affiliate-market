import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireSpaceOwner } from '@/lib/api-auth';

/** GET — list overrides for the next 90 days */
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug');
  const productId = req.nextUrl.searchParams.get('productId');
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (productId && !UUID_RE.test(productId)) {
    return NextResponse.json({ error: 'Invalid productId' }, { status: 400 });
  }

  // All of the space's overrides (ordered by date); apply the product/global
  // filter here (was the PostgREST .or / .is('null') branch).
  const all = await convex().query(api.demos.availability.listBySpace, { spaceId: space.id });
  const scoped = all.filter((o) =>
    productId ? o.productProfileId === productId || o.productProfileId === null : o.productProfileId === null,
  );

  // Filter out past non-recurring overrides
  const today = new Date().toISOString().split('T')[0];
  const filtered = scoped.filter((o) => {
    if (o.recurrence !== 'none') {
      // Keep recurring overrides if endDate is in the future or not set
      return !o.endDate || o.endDate >= today;
    }
    return o.date >= today;
  });

  return NextResponse.json(filtered);
}

/** POST — create or update an override */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { slug, date, isBlocked, startHour, endHour, label, recurrence, endDate, productProfileId } = body;

  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });
  if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Invalid date format (YYYY-MM-DD)' }, { status: 400 });
  }

  const validRecurrences = ['none', 'weekly', 'biweekly', 'monthly'];
  const rec = recurrence && validRecurrences.includes(recurrence) ? recurrence : 'none';

  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return NextResponse.json({ error: 'Invalid endDate format' }, { status: 400 });
  }

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  if (!isBlocked) {
    if (startHour == null || endHour == null) {
      return NextResponse.json({ error: 'startHour and endHour required when not blocked' }, { status: 400 });
    }
    if (startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24 || endHour <= startHour) {
      return NextResponse.json({ error: 'Invalid hour range' }, { status: 400 });
    }
  }

  // Validate product profile if provided
  if (productProfileId) {
    const profile = await convex().query(api.demos.profiles.getById, { id: productProfileId });
    if (!profile || profile.spaceId !== space.id) {
      return NextResponse.json({ error: 'Product profile not found' }, { status: 400 });
    }
  }

  // Upsert folds the "delete existing on (space, date, product) then insert"
  // into one serializable mutation (preserving the NULL-product distinction).
  const data = await convex().mutation(api.demos.availability.upsert, {
    spaceId: space.id,
    productProfileId: productProfileId || null,
    date,
    isBlocked: !!isBlocked,
    startHour: isBlocked ? null : (startHour ?? null),
    endHour: isBlocked ? null : (endHour ?? null),
    label: label?.trim() || null,
    recurrence: rec,
    endDate: rec !== 'none' ? (endDate || null) : null,
  });

  return NextResponse.json(data, { status: 201 });
}
