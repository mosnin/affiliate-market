import { NextResponse, type NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { getClientUser } from '@/lib/client-auth';
import { clientOwnsContact } from '@/lib/client-portal-data';
import { sendClientNotification } from '@/lib/client-email';
import { checkRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const MAX_RESPONSE = 2000;

/**
 * GET /api/clients/info-request?contactId=… — list info-requests on a contact
 * the client owns (pending + already fulfilled, newest first).
 */
export async function GET(req: NextRequest) {
  const user = await getClientUser();
  if (!user?.emailVerifiedAt) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const contactId = req.nextUrl.searchParams.get('contactId');
  if (!contactId) return NextResponse.json({ error: 'contactId required' }, { status: 400 });
  if (!(await clientOwnsContact(user.email, contactId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const requests = await convex().query(api.portal.clientInfoRequests.listForContact, {
    contactId,
  });

  return NextResponse.json({ requests });
}

/**
 * POST /api/clients/info-request — client responds to a pending request. Sets
 * the response + status='fulfilled' and notifies the seller.
 */
export async function POST(req: NextRequest) {
  const user = await getClientUser();
  if (!user?.emailVerifiedAt) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { id?: string; response?: string };
  const id = body.id;
  const response = (body.response ?? '').trim();
  if (!id || response.length === 0) {
    return NextResponse.json({ error: 'id and a response are required' }, { status: 400 });
  }
  if (response.length > MAX_RESPONSE) {
    return NextResponse.json({ error: 'Response too long.' }, { status: 400 });
  }

  const { allowed } = await checkRateLimit(`clients:inforeq:${user.id}`, 20, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });

  // Load the request + verify ownership via its contact.
  const row = await convex().query(api.portal.clientInfoRequests.getGuardFields, { id });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!(await clientOwnsContact(user.email, row.contactId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (row.status !== 'pending') {
    return NextResponse.json({ error: 'Already answered.' }, { status: 409 });
  }

  try {
    await convex().mutation(api.portal.clientInfoRequests.fulfill, { id, response });
  } catch (error) {
    logger.error('[clients/info-request] update failed', { id }, error as Error);
    return NextResponse.json({ error: 'Failed to save.' }, { status: 500 });
  }

  // Notify the seller (best-effort).
  const { data: space } = await supabase
    .from('Space')
    .select('ownerId')
    .eq('id', row.spaceId)
    .maybeSingle();
  const ownerId = (space as { ownerId?: string | null } | null)?.ownerId;
  if (ownerId) {
    const { data: owner } = await supabase.from('User').select('email').eq('id', ownerId).maybeSingle();
    const ownerEmail = (owner as { email?: string | null } | null)?.email;
    if (ownerEmail) {
      void sendClientNotification({
        to: ownerEmail,
        subject: 'A client answered your request',
        heading: 'Request answered',
        body: `${user.name ?? user.email} responded to your information request.`,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
