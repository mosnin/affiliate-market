import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

const VALID_GOAL_TYPES = [
  'follow_up_sequence',
  'demo_booking',
  'offer_progress',
  'deal_close',
  'reengagement',
  'custom',
] as const;

const VALID_GOAL_STATUSES = ['active', 'completed', 'cancelled', 'paused'] as const;
type GoalStatus = (typeof VALID_GOAL_STATUSES)[number];

export async function GET(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const status = req.nextUrl.searchParams.get('status') ?? 'active';
  const limitParam = parseInt(req.nextUrl.searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(isNaN(limitParam) ? 20 : limitParam, 50);
  const contactId = req.nextUrl.searchParams.get('contactId');

  // An out-of-range status used to filter to zero rows in PostgREST; preserve
  // that (return []) rather than 500 on the Convex status validator.
  if (!(VALID_GOAL_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json([]);
  }

  // AgentGoal list (Convex). The Contact:contactId(id,name) embed the old
  // select carried is hydrated from Supabase below (Contact is another domain).
  const rows = await convex().query(api.agent.goals.listBySpace, {
    spaceId: space.id,
    status: status as GoalStatus,
    ...(contactId ? { contactId } : {}),
    limit,
  });

  const contactIds = Array.from(
    new Set(rows.map((r) => r.contactId).filter((id): id is string => !!id)),
  );
  const contactsRes = contactIds.length
    ? await supabase.from('Contact').select('id, name').in('id', contactIds)
    : { data: [] as { id: string; name: string }[] };
  const contactById = new Map(
    (contactsRes.data ?? []).map((c) => [c.id, { id: c.id, name: c.name }]),
  );

  const data = rows.map((r) => ({
    ...r,
    Contact: r.contactId ? contactById.get(r.contactId) ?? null : null,
  }));
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json();
  const { goalType, description, instructions, contactId, dealId, priority } = body;

  if (!goalType || !(VALID_GOAL_TYPES as readonly string[]).includes(goalType)) {
    return NextResponse.json(
      { error: `goalType must be one of: ${VALID_GOAL_TYPES.join(', ')}` },
      { status: 400 },
    );
  }

  if (!description || typeof description !== 'string' || description.trim().length === 0) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 });
  }

  // Validate foreign keys belong to this space
  if (contactId) {
    const { data: c } = await supabase.from('Contact').select('id')
      .eq('id', contactId).eq('spaceId', space.id).maybeSingle();
    if (!c) return NextResponse.json({ error: 'Contact not found' }, { status: 400 });
  }
  if (dealId) {
    const { data: d } = await supabase.from('Deal').select('id')
      .eq('id', dealId).eq('spaceId', space.id).maybeSingle();
    if (!d) return NextResponse.json({ error: 'Deal not found' }, { status: 400 });
  }

  const data = await convex().mutation(api.agent.goals.create, {
    spaceId: space.id,
    goalType,
    description: description.trim(),
    instructions: instructions ?? null,
    contactId: contactId ?? null,
    dealId: dealId ?? null,
    ...(typeof priority === 'number' ? { priority } : {}),
  });

  return NextResponse.json(data, { status: 201 });
}
