import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit } from '@/lib/rate-limit';
import { isReservedConversationTitle } from '@/lib/chat/conversation-access';

const rateLimited = () =>
  NextResponse.json(
    { error: 'too many requests. try again shortly.' },
    { status: 429, headers: { 'Retry-After': '60' } },
  );

async function getConversationAndVerifyOwner(conversationId: string, userId: string) {
  const conv = await convex().query(api.conversations.conversations.getById, { id: conversationId });
  if (!conv) return null;

  // Verify the caller owns the conversation's space. The old embedded
  // `Space(ownerId)` join is now two flat lookups: resolve the owning Space's
  // ownerId, then confirm the caller's User row matches both the Clerk id and
  // that owner id.
  const space = await convex()
    .query(api.workspace.spaces.getById, { id: conv.spaceId })
    .catch(() => null);
  if (!space) return null;

  const user = await convex()
    .query(api.org.users.getByClerkId, { clerkId: userId })
    .catch(() => null);
  if (!user || user.id !== space.ownerId) return null;

  // Surface guard: manager-Cola and team conversations have their own
  // manager-gated routes. A manager_owner also owns their personal seller
  // space, so ownership alone is not isolation. Refuse to rename/delete a
  // manager conversation through the seller endpoint. The reserved-title
  // check lives in lib/chat/conversation-access.
  if (isReservedConversationTitle(conv.title)) {
    return null;
  }

  return conv;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { allowed } = await checkRateLimit(`ai:conversations:${userId}`, 20, 60);
    if (!allowed) return rateLimited();

    const { id } = await params;
    const conv = await getConversationAndVerifyOwner(id, userId);
    if (!conv) return NextResponse.json({ error: 'Not found or Forbidden' }, { status: 404 });

    const { title } = await req.json();
    if (!title || typeof title !== 'string') {
      return NextResponse.json({ error: 'title required' }, { status: 400 });
    }

    let data;
    try {
      data = await convex().mutation(api.conversations.conversations.rename, {
        id,
        title: title.trim(),
      });
    } catch {
      return NextResponse.json({ error: 'Failed to rename conversation' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'Failed to rename conversation' }, { status: 500 });

    return NextResponse.json(data);
  } catch (err) {
    console.error('[conversations/[id]] PATCH error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { allowed } = await checkRateLimit(`ai:conversations:${userId}`, 20, 60);
    if (!allowed) return rateLimited();

    const { id } = await params;
    const conv = await getConversationAndVerifyOwner(id, userId);
    if (!conv) return NextResponse.json({ error: 'Not found or Forbidden' }, { status: 404 });

    try {
      await convex().mutation(api.conversations.conversations.deleteForSpace, {
        id,
        spaceId: conv.spaceId,
      });
    } catch {
      return NextResponse.json({ error: 'Failed to delete conversation' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[conversations/[id]] DELETE error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
