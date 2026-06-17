import { NextResponse, type NextRequest } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { getClientUser } from '@/lib/client-auth';
import { clientOwnsContact } from '@/lib/client-portal-data';
import { sendClientNotification } from '@/lib/client-email';
import { checkRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const MAX_BODY = 2000;

/**
 * GET /api/clients/messages?contactId=… — thread for one contact, scoped to
 * the signed-in client by clientOwnsContact (verified email is the boundary).
 * Marks the seller's messages as read on fetch.
 */
export async function GET(req: NextRequest) {
  const user = await getClientUser();
  if (!user?.emailVerifiedAt) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const contactId = req.nextUrl.searchParams.get('contactId');
  if (!contactId) return NextResponse.json({ error: 'contactId required' }, { status: 400 });
  if (!(await clientOwnsContact(user.email, contactId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const messages = await convex().query(api.conversations.clientMessages.listForContact, {
    contactId,
  });

  // Mark seller → client messages read now that the client has loaded them.
  await convex().mutation(api.conversations.clientMessages.markRead, {
    contactId,
    senderType: 'seller',
  });

  return NextResponse.json({ messages });
}

/**
 * POST /api/clients/messages — client sends a message on a contact they own.
 * Optionally notifies the seller by email (best-effort).
 */
export async function POST(req: NextRequest) {
  const user = await getClientUser();
  if (!user?.emailVerifiedAt) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { contactId?: string; body?: string };
  const contactId = body.contactId;
  const text = (body.body ?? '').trim();

  if (!contactId || text.length === 0) {
    return NextResponse.json({ error: 'contactId and a message are required' }, { status: 400 });
  }
  if (text.length > MAX_BODY) {
    return NextResponse.json({ error: 'Message too long.' }, { status: 400 });
  }
  if (!(await clientOwnsContact(user.email, contactId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { allowed } = await checkRateLimit(`clients:msg:${user.id}`, 30, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many messages. Slow down.' }, { status: 429 });

  // Resolve the contact's space (needed for the row + seller lookup).
  const contact = await convex().query(api.contacts.contacts.getById, { id: contactId });
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let inserted;
  try {
    inserted = await convex().mutation(api.conversations.clientMessages.send, {
      contactId,
      spaceId: contact.spaceId,
      senderType: 'client',
      body: text,
    });
  } catch (error) {
    logger.error('[clients/messages] insert failed', { contactId }, error);
    return NextResponse.json({ error: 'Failed to send.' }, { status: 500 });
  }

  // Best-effort seller notification. Resolve the owner's email via User.
  const space = await convex().query(api.workspace.spaces.getById, { id: contact.spaceId });
  if (space?.ownerId) {
    const owner = await convex().query(api.org.users.getById, { id: space.ownerId });
    const ownerEmail = owner?.email;
    if (ownerEmail) {
      void sendClientNotification({
        to: ownerEmail,
        subject: 'New message from a client',
        heading: 'You have a new message',
        body: `${user.name ?? user.email} sent you a message in their portal.`,
      });
    }
  }

  return NextResponse.json({ message: inserted }, { status: 201 });
}
