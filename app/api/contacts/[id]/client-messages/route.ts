import { NextResponse, type NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { requireContactAccess } from '@/lib/api-auth';
import { sendClientNotification } from '@/lib/client-email';
import { checkRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const MAX_BODY = 2000;

/**
 * GET /api/contacts/[id]/client-messages — seller reads the client-portal
 * thread for one of their contacts. Marks client → seller messages read.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: contactId } = await params;
  const auth = await requireContactAccess(contactId);
  if (auth instanceof NextResponse) return auth;

  const messages = await convex().query(api.conversations.clientMessages.listForContact, {
    contactId,
  });

  await convex().mutation(api.conversations.clientMessages.markRead, {
    contactId,
    senderType: 'client',
  });

  return NextResponse.json({ messages });
}

/**
 * POST /api/contacts/[id]/client-messages — seller replies (senderType
 * 'seller'). Notifies the client by their contact email (best-effort).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: contactId } = await params;
  const auth = await requireContactAccess(contactId);
  if (auth instanceof NextResponse) return auth;
  const { userId, space } = auth;

  const body = (await req.json().catch(() => ({}))) as { body?: string };
  const text = (body.body ?? '').trim();
  if (text.length === 0) return NextResponse.json({ error: 'Write a message.' }, { status: 400 });
  if (text.length > MAX_BODY) return NextResponse.json({ error: 'Message too long.' }, { status: 400 });

  const { allowed } = await checkRateLimit(`contacts:msg:${userId}`, 60, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many messages.' }, { status: 429 });

  let inserted;
  try {
    inserted = await convex().mutation(api.conversations.clientMessages.send, {
      contactId,
      spaceId: space.id,
      senderType: 'seller',
      body: text,
    });
  } catch (error) {
    logger.error('[contacts/client-messages] insert failed', { contactId }, error);
    return NextResponse.json({ error: 'Failed to send.' }, { status: 500 });
  }

  const { data: contact } = await supabase
    .from('Contact')
    .select('email')
    .eq('id', contactId)
    .maybeSingle();
  const email = (contact as { email?: string | null } | null)?.email;
  if (email) {
    void sendClientNotification({
      to: email,
      subject: `New message from ${space.name ?? 'your agent'}`,
      heading: 'You have a new message',
      body: 'Your agent replied in your portal.',
    });
  }

  return NextResponse.json({ message: inserted }, { status: 201 });
}
