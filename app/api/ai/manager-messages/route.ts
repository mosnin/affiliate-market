/**
 * GET /api/ai/manager-messages?conversationId= — messages for a manager Cola
 * conversation.
 *
 * The manager analogue of `app/api/ai/messages/route.ts`. Gated on manager
 * access via `resolveManagerContext()` (defense layer 2). The conversation is
 * verified to belong to the caller's company BEFORE any message is returned —
 * a conversationId from another company (or a seller conversation, which
 * won't even exist in "ManagerConversation") gets a 404, never another
 * company's history.
 *
 * Storage is structurally separate: messages come from "ManagerMessage", keyed
 * by companyId + conversationId. There is no path from here into the seller
 * "Message" table.
 */

import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { resolveManagerContext } from '@/lib/agent/manager-context';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const MESSAGE_LIMIT = 50;

export async function GET(req: NextRequest) {
  try {
    const managerCtx = await resolveManagerContext();
    if (!managerCtx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const { allowed } = await checkRateLimit(`ai:manager-messages:${managerCtx.company.ownerId}`, 20, 60);
    if (!allowed) {
      return NextResponse.json(
        { error: 'too many requests. try again shortly.' },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    }

    const conversationId = req.nextUrl.searchParams.get('conversationId');
    if (!conversationId) return NextResponse.json({ error: 'conversationId required' }, { status: 400 });

    // Verify the conversation belongs to THIS company before loading any
    // message. companyId is the boundary — ownership of the conversation row
    // is what gates access, not a title string.
    let conv;
    try {
      conv = await convex().query(api.conversations.managerConversations.getById, {
        id: conversationId,
      });
    } catch (convErr) {
      console.error('[manager-messages] Conversation lookup failed:', convErr);
      return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
    }
    if (!conv || conv.companyId !== managerCtx.company.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    let data;
    try {
      data = await convex().query(api.conversations.managerMessages.listForConversation, {
        conversationId,
        limit: MESSAGE_LIMIT,
      });
    } catch (error) {
      console.error('[manager-messages] Message lookup failed:', error);
      return NextResponse.json({ error: 'Failed to load messages' }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error('[manager-messages] GET error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
