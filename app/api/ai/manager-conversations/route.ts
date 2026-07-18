/**
 * Conversation CRUD for the manager Cola surface.
 *
 * Parallel to `app/api/ai/conversations/route.ts` (the seller route) but
 * gated on manager access via `resolveManagerContext()` (defense layer 2).
 *
 * STORAGE IS STRUCTURALLY SEPARATE. Manager conversations live in their OWN
 * "ManagerConversation" table, keyed by `companyId` — NOT on a Space, NOT with
 * a title prefix. The companyId column is the boundary, so a seller surface
 * can never enumerate a manager conversation: the rows are not in its table.
 *
 * Phase 1 scope: create + list conversations the manager has had with Cola.
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

export async function GET(_req: NextRequest) {
  const managerCtx = await resolveManagerContext();
  if (!managerCtx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { allowed } = await checkRateLimit(`ai:manager-conversations:${managerCtx.company.ownerId}`, 20, 60);
  if (!allowed) return rateLimited();

  let conversations;
  try {
    conversations = await convex().query(api.conversations.managerConversations.listByCompany, {
      companyId: managerCtx.company.id,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to load conversations' }, { status: 500 });
  }

  // Preview line per conversation = the latest message's content. The Convex
  // query resolves the newest message per conversationId; the whitespace
  // collapse + 60-char truncation stays here, exactly as before.
  const ids = conversations.map((c) => c.id);
  const previewMap: Record<string, string> = {};
  if (ids.length > 0) {
    const latest = await convex().query(api.conversations.managerMessages.latestPreviewContent, {
      conversationIds: ids,
    });
    for (const [conversationId, content] of Object.entries(latest)) {
      const text = (content ?? '').replace(/\s+/g, ' ').trim();
      previewMap[conversationId] = text.length > 60 ? text.slice(0, 59) + '…' : text;
    }
  }

  const result = conversations.map((c) => ({ ...c, preview: previewMap[c.id] ?? null }));
  return NextResponse.json(result);
}

export async function POST(_req: NextRequest) {
  const managerCtx = await resolveManagerContext();
  if (!managerCtx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { allowed } = await checkRateLimit(`ai:manager-conversations:${managerCtx.company.ownerId}`, 20, 60);
  if (!allowed) return rateLimited();

  let data;
  try {
    // title defaults to 'New conversation' inside the mutation (the PG default).
    data = await convex().mutation(api.conversations.managerConversations.create, {
      companyId: managerCtx.company.id,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
