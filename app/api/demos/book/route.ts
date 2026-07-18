import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { getSpaceFromSlug } from '@/lib/space';
import { sendDemoConfirmation, type DemoEmailData } from '@/lib/demo-emails';
import { notifyNewDemo } from '@/lib/notify';
import { sendSMS, demoConfirmationSMS } from '@/lib/sms';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

/** Public endpoint — guests book a demo without authentication. */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  // Per-IP cap — tightened from 10 to 3/hour. The booking endpoint sends a
  // real-looking confirmation email to whatever `guestEmail` is provided,
  // which is a platform-as-spammer amplifier. A single IP shouldn't be
  // legitimately booking 3+ demos per hour.
  const { allowed } = await checkRateLimit(`book:rl:${ip}`, 3, 3600);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const body = await req.json();
  const { slug, guestName, guestEmail, guestPhone, productAddress, notes, startsAt, productProfileId } = body;

  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });
  if (!guestName?.trim() || !guestEmail?.trim() || !startsAt) {
    return NextResponse.json({ error: 'guestName, guestEmail, startsAt required' }, { status: 400 });
  }

  // Length check FIRST — defends against running the regex on a multi-MB
  // string (ReDoS-ish CPU burn).
  if (guestEmail.length > 254) {
    return NextResponse.json({ error: 'Email too long' }, { status: 400 });
  }
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(guestEmail.trim())) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
  }

  // Input length validation to prevent storage DoS
  if (guestName.length > 200) return NextResponse.json({ error: 'Name too long' }, { status: 400 });
  if (guestPhone && guestPhone.length > 50) return NextResponse.json({ error: 'Phone too long' }, { status: 400 });
  if (productAddress && productAddress.length > 500) return NextResponse.json({ error: 'Address too long' }, { status: 400 });
  if (notes && notes.length > 2000) return NextResponse.json({ error: 'Notes too long' }, { status: 400 });

  const space = await getSpaceFromSlug(slug);
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  // Per-space cap — catches distributed attacks (botnets rotating IPs) hitting
  // a single victim space. A real space gets at most a handful of bookings per
  // hour; 20 is well above legitimate traffic and well below the daily volume
  // a spammer would want.
  const spaceCheck = await checkRateLimit(`book:space:${space.id}`, 20, 3600);
  if (!spaceCheck.allowed) {
    return NextResponse.json({ error: 'Too many requests for this space' }, { status: 429 });
  }

  // Get duration from settings
  const settings = await convex().query(api.workspace.settings.getBySpace, {
    spaceId: space.id,
  });
  let duration = settings?.demoDuration ?? 30;

  // Validate productProfileId belongs to this space before using it,
  // and use its demo duration if available
  let validProductProfileId: string | null = null;
  if (productProfileId) {
    const profileRow = await convex().query(api.demos.profiles.getById, { id: productProfileId });
    // Must belong to this space and be active (was the .eq('spaceId').eq('isActive', true) filter).
    if (profileRow && profileRow.spaceId === space.id && profileRow.isActive) {
      validProductProfileId = profileRow.id;
      duration = profileRow.demoDuration;
    }
    // If profile not found or not active, proceed without it (don't block booking)
  }

  const start = new Date(startsAt);
  if (isNaN(start.getTime())) {
    return NextResponse.json({ error: 'Invalid startsAt' }, { status: 400 });
  }
  if (start.getTime() < Date.now()) {
    return NextResponse.json({ error: 'Cannot book in the past' }, { status: 400 });
  }

  const end = new Date(start.getTime() + duration * 60 * 1000);

  // Try to match to existing contact by email, or create one
  let contactId: string | null = null;
  const contactRow = await convex().query(api.contacts.contacts.findByEmailInSpace, {
    spaceId: space.id,
    email: guestEmail.trim(),
  });

  if (contactRow) {
    contactId = contactRow.id;
    // Set source attribution if not already set. Awaited — the prior
    // fire-and-forget pattern could be GC'd on a cold Vercel function
    // before the update committed, so first-touch attribution was missed
    // intermittently. Cost is one extra serial query; the route already
    // does several.
    try {
      await convex().mutation(api.contacts.contacts.update, {
        id: contactId,
        spaceId: space.id,
        patch: { sourceLabel: 'demo-booking' },
        setSourceLabelOnlyIfNull: true,
      });
    } catch (srcErr) {
      console.error('[book] Source update failed:', srcErr);
    }
  } else {
    // Auto-create a contact for this demo guest
    const newContactId = crypto.randomUUID();
    try {
      await convex().mutation(api.contacts.contacts.create, {
        id: newContactId,
        spaceId: space.id,
        name: guestName.trim(),
        email: guestEmail.trim().toLowerCase(),
        phone: guestPhone?.trim() || null,
        address: productAddress?.trim() || null,
        type: 'DEMO',
        tags: ['demo-booking'],
        sourceLabel: 'demo-booking',
        // `'unscored'` violated the CHECK constraint
        // (`contact_scoring_status_check` allows pending/scored/failed only),
        // so every auto-create silently failed and the demo was booked with
        // a NULL contactId — losing attribution and breaking follow-ups.
        scoringStatus: 'pending',
      });
      contactId = newContactId;
    } catch (createErr) {
      console.error('[book] Auto-create contact failed:', createErr);
    }
  }

  // Generate a cryptographically secure manage token (256-bit entropy)
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const manageToken = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, '0')).join('');

  // Atomic booking — the book mutation does the conflict check + insert in one
  // serializable transaction (the old book_demo_atomic RPC) and returns the
  // inserted row, so no follow-up fetch is needed. null means a conflict.
  const demoId = crypto.randomUUID();
  const demo = await convex().mutation(api.demos.demos.book, {
    id: demoId,
    spaceId: space.id,
    contactId,
    guestName: guestName.trim(),
    guestEmail: guestEmail.trim().toLowerCase(),
    guestPhone: guestPhone?.trim() || null,
    productAddress: productAddress?.trim() || null,
    notes: notes?.trim() || null,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    productProfileId: validProductProfileId,
    manageToken,
  });

  // null return means a conflicting demo was found
  if (!demo) {
    return NextResponse.json({ error: 'This time slot is no longer available' }, { status: 409 });
  }

  // Send confirmation email (non-blocking)
  const settingsFull = await convex().query(api.workspace.settings.getBySpace, {
    spaceId: space.id,
  });
  const emailData: DemoEmailData = {
    guestName: demo.guestName,
    guestEmail: demo.guestEmail,
    guestPhone: demo.guestPhone,
    productAddress: demo.productAddress,
    startsAt: demo.startsAt,
    endsAt: demo.endsAt,
    businessName: settingsFull?.businessName || space.name,
    demoId: demo.id,
    slug,
  };
  try { await sendDemoConfirmation(emailData); } catch (e) { console.error('[demos] confirmation email failed:', e); }

  // Send SMS confirmation to guest
  if (demo.guestPhone) {
    const d = new Date(demo.startsAt);
    try {
      await sendSMS(
        demoConfirmationSMS({
          guestName: demo.guestName,
          guestPhone: demo.guestPhone,
          businessName: settingsFull?.businessName || space.name,
          date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          product: demo.productAddress,
        })
      );
    } catch (e) { console.error('[demos] SMS confirmation failed:', e); }
  }

  // Notify the space owner (email + SMS via unified dispatcher)
  try { await notifyNewDemo({ spaceId: space.id, demoData: emailData }); } catch (e) { console.error('[demos] owner notification failed:', e); }

  return NextResponse.json(demo, { status: 201 });
}
