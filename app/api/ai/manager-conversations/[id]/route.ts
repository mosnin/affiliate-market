/**
 * Rename / delete a single manager Cola conversation.
 *
 * The manager analogue of `app/api/ai/conversations/[id]/route.ts`. Gated on
 * manager access via `resolveManagerContext()` (defense layer 2), and every
 * mutation is scoped to the caller's company: the row must belong to THIS
 * company or it 404s. Operates on the separate "ManagerConversation" /
 * "ManagerMessage" tables — never the seller "Conversation"/"Message" tables.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { resolveManagerContext } from '@/lib/agent/manager-context';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const rateLimited = () =>
  NextResponse.json(
    { error: 'too many requests. try again shortly.' },
    { status: 429, headers: { 'Retry-After': '60' } },
  );

/** Resolve the conversation only if it belongs to the caller's company. */
async function ownedConversation(conversationId: string, companyId: string) {
  const data = await convex().query(api.conversations.managerConversations.getById, {
    id: conversationId,
  });
  if (!data || data.companyId !== companyId) return null;
  return data;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const managerCtx = await resolveManagerContext();
  if (!managerCtx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { allowed } = await checkRateLimit(`ai:manager-conversations:${managerCtx.company.ownerId}`, 20, 60);
  if (!allowed) return rateLimited();

  const { id } = await params;
  const conv = await ownedConversation(id, managerCtx.company.id);
  if (!conv) return NextResponse.json({ error: 'Not found or Forbidden' }, { status: 404 });

  const { title } = await req.json();
  if (!title || typeof title !== 'string') {
    return NextResponse.json({ error: 'title required' }, { status: 400 });
  }

  let data;
  try {
    data = await convex().mutation(api.conversations.managerConversations.rename, {
      id,
      companyId: managerCtx.company.id,
      title: title.trim(),
    });
  } catch {
    return NextResponse.json({ error: 'Failed to rename conversation' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Failed to rename conversation' }, { status: 500 });

  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const managerCtx = await resolveManagerContext();
  if (!managerCtx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { allowed } = await checkRateLimit(`ai:manager-conversations:${managerCtx.company.ownerId}`, 20, 60);
  if (!allowed) return rateLimited();

  const { id } = await params;
  const conv = await ownedConversation(id, managerCtx.company.id);
  if (!conv) return NextResponse.json({ error: 'Not found or Forbidden' }, { status: 404 });

  // "ManagerMessage" rows cascaded on the conversation FK in Postgres; the
  // deleteForCompany mutation removes them explicitly inside one mutation, so
  // deleting the conversation still removes its messages too.
  try {
    await convex().mutation(api.conversations.managerConversations.deleteForCompany, {
      id,
      companyId: managerCtx.company.id,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to delete conversation' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
