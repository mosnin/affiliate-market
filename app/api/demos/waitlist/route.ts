import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { getSpaceFromSlug } from '@/lib/space';
import { requireSpaceOwner } from '@/lib/api-auth';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

/** GET — list waitlist entries (authenticated, space owner) */
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  const data = await convex().query(api.demos.waitlist.listBySpace, {
    spaceId: space.id,
    statuses: ['waiting', 'notified'],
  });

  return NextResponse.json(data);
}

/** POST — public endpoint: guest joins the waitlist */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const { allowed } = await checkRateLimit(`waitlist:${ip}`, 5, 3600);
  if (!allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const body = await req.json();
  const { slug, guestName, guestEmail, guestPhone, preferredDate, notes, productProfileId } = body;

  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });
  if (!guestName?.trim() || !guestEmail?.trim() || !preferredDate) {
    return NextResponse.json({ error: 'guestName, guestEmail, preferredDate required' }, { status: 400 });
  }

  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(guestEmail.trim()) || guestEmail.length > 254) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
  }

  // Input length validation
  if (guestName.length > 200) return NextResponse.json({ error: 'Name too long' }, { status: 400 });
  if (guestPhone && guestPhone.length > 50) return NextResponse.json({ error: 'Phone too long' }, { status: 400 });
  if (notes && notes.length > 2000) return NextResponse.json({ error: 'Notes too long' }, { status: 400 });

  const space = await getSpaceFromSlug(slug);
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  // Create with the one-'waiting'-per-(space,email,date) dedupe folded into the
  // mutation; null return means a duplicate already exists.
  const data = await convex().mutation(api.demos.waitlist.create, {
    spaceId: space.id,
    productProfileId: productProfileId || null,
    guestName: guestName.trim(),
    guestEmail: guestEmail.trim().toLowerCase(),
    guestPhone: guestPhone?.trim() || null,
    preferredDate,
    notes: notes?.trim() || null,
  });
  if (!data) {
    return NextResponse.json({ error: 'You are already on the waitlist for this date' }, { status: 409 });
  }

  return NextResponse.json(data, { status: 201 });
}
