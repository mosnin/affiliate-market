import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { getSpaceFromSlug } from '@/lib/space';
import { checkRateLimit } from '@/lib/rate-limit';
import { isReservedConversationTitle } from '@/lib/chat/conversation-access';

const rateLimited = () =>
  NextResponse.json(
    { error: 'too many requests. try again shortly.' },
    { status: 429, headers: { 'Retry-After': '60' } },
  );

export async function GET(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { allowed } = await checkRateLimit(`ai:conversations:${userId}`, 20, 60);
    if (!allowed) return rateLimited();

    const slug = req.nextUrl.searchParams.get('slug');
    if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

    const space = await getSpaceFromSlug(slug);
    if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

    const { data: owner } = await supabase
      .from('User')
      .select('id')
      .eq('clerkId', userId)
      .eq('id', space.ownerId)
      .maybeSingle();
    if (!owner) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    let conversations;
    try {
      const rows = await convex().query(api.conversations.conversations.listBySpace, {
        spaceId: space.id,
      });
      // Reserved manager/team prefixes are sourced from
      // lib/chat/conversation-access so the seller exclusion set lives in one
      // place. The seller surface never serves manager-Cola or team chats.
      // Convex has no `NOT LIKE`, so the prefix exclusion runs here in memory —
      // the same exclusion the old `.not('title','like', …)` performed.
      conversations = rows.filter((c) => !isReservedConversationTitle(c.title));
    } catch {
      return NextResponse.json({ error: 'Failed to load conversations' }, { status: 500 });
    }

    // Fetch the last message for each conversation to provide a preview line.
    // The Convex query resolves the newest message per conversationId; the
    // whitespace-collapse + 60-char truncation stays here, exactly as before.
    const ids = conversations.map((c) => c.id);
    const previewMap: Record<string, string> = {};
    if (ids.length > 0) {
      const latest = await convex().query(api.conversations.messages.latestPreviewContent, {
        conversationIds: ids,
      });
      for (const [conversationId, content] of Object.entries(latest)) {
        const text = (content ?? '').replace(/\s+/g, ' ').trim();
        previewMap[conversationId] = text.length > 60 ? text.slice(0, 59) + '…' : text;
      }
    }

    const result = conversations.map((c) => ({
      ...c,
      preview: previewMap[c.id] ?? null,
    }));

    return NextResponse.json(result);
  } catch (err) {
    console.error('[conversations] GET error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { allowed } = await checkRateLimit(`ai:conversations:${userId}`, 20, 60);
    if (!allowed) return rateLimited();

    const { slug } = await req.json();
    if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

    const space = await getSpaceFromSlug(slug);
    if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

    const { data: owner } = await supabase
      .from('User')
      .select('id')
      .eq('clerkId', userId)
      .eq('id', space.ownerId)
      .maybeSingle();
    if (!owner) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    let data;
    try {
      // title defaults to 'New conversation' inside the mutation (the PG default).
      data = await convex().mutation(api.conversations.conversations.create, {
        spaceId: space.id,
      });
    } catch {
      return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    console.error('[conversations] POST error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
