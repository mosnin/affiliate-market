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

  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '50'), 200);
  const agentType = req.nextUrl.searchParams.get('agentType');
  const outcome = req.nextUrl.searchParams.get('outcome');

  // AgentActivityLog feed (Convex). Returns only the log's own columns; the
  // Contact:relatedContactId / Deal:relatedDealId embeds the old PostgREST
  // select carried are hydrated from Supabase below (those tables are other
  // domains — hybrid).
  const rows = await convex().query(api.agent.activity.feed, {
    spaceId: space.id,
    limit,
    ...(agentType ? { agentType } : {}),
    ...(outcome ? { outcome: outcome as 'completed' | 'queued_for_approval' | 'suggested' | 'failed' } : {}),
  });

  // Hydrate the Contact/Deal embeds in one batched read each, preserving the
  // old nested shape: row.Contact = { id, name }, row.Deal = { id, title }.
  const contactIds = Array.from(
    new Set(rows.map((r) => r.relatedContactId).filter((id): id is string => !!id)),
  );
  const dealIds = Array.from(
    new Set(rows.map((r) => r.relatedDealId).filter((id): id is string => !!id)),
  );

  const [contactsRes, dealsRes] = await Promise.all([
    contactIds.length
      ? supabase.from('Contact').select('id, name').in('id', contactIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    dealIds.length
      ? supabase.from('Deal').select('id, title').in('id', dealIds)
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
  ]);

  const contactById = new Map(
    (contactsRes.data ?? []).map((c) => [c.id, { id: c.id, name: c.name }]),
  );
  const dealById = new Map(
    (dealsRes.data ?? []).map((d) => [d.id, { id: d.id, title: d.title }]),
  );

  const data = rows.map((r) => ({
    ...r,
    Contact: r.relatedContactId ? contactById.get(r.relatedContactId) ?? null : null,
    Deal: r.relatedDealId ? dealById.get(r.relatedDealId) ?? null : null,
  }));

  return NextResponse.json(data ?? []);
}
