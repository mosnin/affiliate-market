import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

export async function GET(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const status = req.nextUrl.searchParams.get('status') ?? 'pending';
  const limitParam = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10);
  const limit = Math.min(isNaN(limitParam) ? 50 : limitParam, 100);

  // Convex's status arg is a closed union; an unknown status would throw there,
  // whereas the old `.eq('status', status)` simply matched nothing and returned
  // []. Preserve that: short-circuit any out-of-range status to an empty list.
  const VALID_STATUSES = ['pending', 'approved', 'dismissed', 'sent'] as const;
  type DraftStatus = (typeof VALID_STATUSES)[number];
  if (!(VALID_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json([]);
  }

  // AgentDraft → Convex. The Contact:contactId join stays in this caller — the
  // Convex draft fns return only AgentDraft columns by design — so we hydrate
  // Contact from Supabase to keep the exact { id, name, email, phone } shape the
  // draft inbox reads.
  const drafts = await convex().query(api.agent.drafts.listBySpaceStatus, {
    spaceId: space.id,
    status: status as DraftStatus,
    limit,
  });

  const contactIds = Array.from(
    new Set(drafts.map((d) => d.contactId).filter((id): id is string => !!id)),
  );

  const contactsById = new Map<string, { id: string; name: string; email: string | null; phone: string | null }>();
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from('Contact')
      .select('id, name, email, phone')
      .eq('spaceId', space.id)
      .in('id', contactIds);
    for (const c of (contacts ?? []) as Array<{ id: string; name: string; email: string | null; phone: string | null }>) {
      contactsById.set(c.id, { id: c.id, name: c.name, email: c.email ?? null, phone: c.phone ?? null });
    }
  }

  const data = drafts.map((d) => ({
    id: d.id,
    contactId: d.contactId,
    dealId: d.dealId,
    channel: d.channel,
    subject: d.subject,
    content: d.content,
    reasoning: d.reasoning,
    priority: d.priority,
    status: d.status,
    confidence: d.confidence,
    expiresAt: d.expiresAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    triggerSource: d.triggerSource,
    Contact: d.contactId ? contactsById.get(d.contactId) ?? null : null,
  }));

  return NextResponse.json(data);
}
