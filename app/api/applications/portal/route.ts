import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

/**
 * GET /api/applications/portal?ref={applicationRef}&token={statusPortalToken}
 *
 * Public endpoint — applicant access via token-based auth.
 * Returns application status, status history, messages, and submitted data summary.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ref = searchParams.get('ref');
  const token = searchParams.get('token');

  if (!ref || !token) {
    return NextResponse.json({ error: 'Missing ref or token' }, { status: 400 });
  }

  // Validate token format: reject obviously invalid tokens early to avoid DB lookups
  if (ref.length < 10 || ref.length > 64 || token.length < 32 || token.length > 128) {
    return NextResponse.json({ error: 'Application not found' }, { status: 404 });
  }

  // Rate limit by IP to prevent token brute-force attacks
  const ip = getClientIp(req);
  const { allowed } = await checkRateLimit(`portal:get:${ip}`, 20, 3600);
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Try again in a bit.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  // Validate both applicationRef AND statusPortalToken match (defense in depth)
  const { data: contact, error: contactError } = await supabase
    .from('Contact')
    .select(
      'id, name, applicationStatus, applicationStatusNote, applicationRef, spaceId, createdAt',
    )
    .eq('applicationRef', ref)
    .eq('statusPortalToken', token)
    .maybeSingle();

  if (contactError) {
    console.error('[portal] Contact lookup error:', contactError);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }

  if (!contact) {
    return NextResponse.json({ error: 'Application not found' }, { status: 404 });
  }

  // Fetch status history
  const statusHistory = await convex().query(api.portal.applicationStatus.listForContact, {
    contactId: contact.id,
  });

  // Fetch messages
  const messages = await convex().query(api.portal.applicationMessages.listForContact, {
    contactId: contact.id,
  });

  // Fetch demos linked to this contact. Filter to active/recent statuses
  // — applicants don't need to see cancelled demos linger in their portal.
  const demos = await convex().query(api.demos.demos.listByContact, {
    contactId: contact.id,
    statuses: ['scheduled', 'confirmed', 'completed'],
    order: 'asc',
  });

  // Mark unread seller messages as read
  if (messages.some((m) => m.senderType === 'seller' && !m.readAt)) {
    const unreadIds = messages
      .filter((m) => m.senderType === 'seller' && !m.readAt)
      .map((m) => m.id);

    await convex().mutation(api.portal.applicationMessages.markRead, {
      contactId: contact.id,
      ids: unreadIds,
    });
  }

  // Fetch business name for display
  const { data: settings } = await supabase
    .from('SpaceSetting')
    .select('businessName')
    .eq('spaceId', contact.spaceId)
    .maybeSingle();

  return NextResponse.json({
    contact: {
      name: contact.name,
      status: contact.applicationStatus ?? 'received',
      statusNote: contact.applicationStatusNote,
      applicationRef: contact.applicationRef,
      createdAt: contact.createdAt,
    },
    statusHistory: statusHistory ?? [],
    messages: messages ?? [],
    demos: demos ?? [],
    businessName: settings?.businessName ?? null,
  });
}
