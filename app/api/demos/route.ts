import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireSpaceOwner } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  const status = req.nextUrl.searchParams.get('status');
  const upcoming = req.nextUrl.searchParams.get('upcoming');

  // upcoming=true forces the scheduled/confirmed pair + startsAt>=now; otherwise
  // an optional single ?status= filter. Ordered by startsAt asc, capped at 100.
  const statuses = upcoming === 'true'
    ? (['scheduled', 'confirmed'] as const)
    : status
      ? ([status] as ('scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show')[])
      : undefined;
  const rows = await convex().query(api.demos.demos.listBySpace, {
    spaceId: space.id,
    ...(statuses ? { statuses: statuses as ('scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show')[] } : {}),
    ...(upcoming === 'true' ? { startsAtGte: new Date().toISOString() } : {}),
    order: 'asc',
    limit: 100,
  });

  // The PostgREST `Contact(id, name, email, phone)` embed can't ride a Convex
  // query — batch-resolve the linked contacts via Convex and stitch each onto
  // its demo to preserve the response shape.
  const contactIds = Array.from(
    new Set(rows.map((d) => d.contactId).filter((id): id is string => Boolean(id))),
  );
  const contactMap = new Map<string, { id: string; name: string; email: string | null; phone: string | null }>();
  if (contactIds.length > 0) {
    const contactRows = await convex().query(api.contacts.contacts.getManyByIds, {
      ids: contactIds,
    });
    for (const c of contactRows) {
      contactMap.set(c.id, { id: c.id, name: c.name, email: c.email ?? null, phone: c.phone ?? null });
    }
  }
  const data = rows.map((d) => ({ ...d, Contact: d.contactId ? contactMap.get(d.contactId) ?? null : null }));

  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { slug, guestName, guestEmail, guestPhone, productAddress, notes, startsAt, endsAt, contactId } = body;

  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });
  if (!guestName || !guestEmail || !startsAt || !endsAt) {
    return NextResponse.json({ error: 'guestName, guestEmail, startsAt, endsAt required' }, { status: 400 });
  }

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
  }

  // Verify linked contact belongs to this space
  let validContactId: string | null = null;
  if (contactId) {
    const contactRow = await convex().query(api.contacts.contacts.getById, {
      id: contactId,
      spaceId: space.id,
    });
    validContactId = contactRow?.id ?? null;
  }

  // Generate a manage token even for manually-created demos — the guest
  // still gets a /demo/[token] URL in their confirmation, so they can
  // self-cancel without bothering the agent.
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const manageToken = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, '0')).join('');

  // Route through the same atomic booking the public /book endpoint uses —
  // locks overlapping demos and rejects conflicts. Without this, an agent
  // creating a manual demo on an already-booked slot silently double-books.
  // The mutation returns the inserted row, so no follow-up fetch is needed.
  const demoId = crypto.randomUUID();
  const data = await convex().mutation(api.demos.demos.book, {
    id: demoId,
    spaceId: space.id,
    contactId: validContactId,
    guestName: guestName.trim(),
    guestEmail: guestEmail.trim().toLowerCase(),
    guestPhone: guestPhone?.trim() || null,
    productAddress: productAddress?.trim() || null,
    notes: notes?.trim() || null,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    productProfileId: null,
    manageToken,
  });
  if (!data) {
    return NextResponse.json({ error: 'This time slot conflicts with an existing demo' }, { status: 409 });
  }

  return NextResponse.json(data, { status: 201 });
}
