import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireAuth } from '@/lib/api-auth';
import { getSpaceForUser } from '@/lib/space';

const VALID_QUESTION_STATUSES = ['pending', 'answered', 'expired'] as const;
type QuestionStatus = (typeof VALID_QUESTION_STATUSES)[number];

export async function GET(req: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;

  const space = await getSpaceForUser(userId);
  if (!space) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const status = req.nextUrl.searchParams.get('status') ?? 'pending';
  const limitParam = parseInt(req.nextUrl.searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(isNaN(limitParam) ? 20 : limitParam, 50);

  // Convex's status arg is a closed union; an unknown status would throw there,
  // whereas the old `.eq('status', status)` matched nothing and returned [].
  // Preserve that: short-circuit any out-of-range status to an empty list.
  if (!(VALID_QUESTION_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json([]);
  }

  // AgentQuestion list (Convex). The Contact:contactId(id,name) embed the old
  // select carried is hydrated from Supabase below (Contact is another domain).
  const rows = await convex().query(api.agent.questions.listBySpace, {
    spaceId: space.id,
    status: status as QuestionStatus,
    limit,
  });

  const contactIds = Array.from(
    new Set(rows.map((r) => r.contactId).filter((id): id is string => !!id)),
  );
  // Hydrate (id, name) for the embed. The old read scoped by id-set only (no
  // spaceId), so getManyByIds is called without a spaceId to match exactly.
  const contactRows = contactIds.length
    ? await convex().query(api.contacts.contacts.getManyByIds, { ids: contactIds })
    : [];
  const contactById = new Map(
    contactRows.map((c) => [c.id, { id: c.id, name: c.name }]),
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
  const { question, context, contactId, priority, agentType, runId } = body;

  if (typeof question !== 'string' || question.length < 10 || question.length > 500) {
    return NextResponse.json(
      { error: 'question must be between 10 and 500 characters' },
      { status: 400 },
    );
  }

  if (context !== undefined && context !== null) {
    if (typeof context !== 'string' || context.length > 1000) {
      return NextResponse.json(
        { error: 'context must be 1000 characters or fewer' },
        { status: 400 },
      );
    }
  }

  // Validate contactId belongs to this space if provided
  if (contactId) {
    const c = await convex()
      .query(api.contacts.contacts.getById, { id: contactId, spaceId: space.id })
      .catch(() => null);
    if (!c) return NextResponse.json({ error: 'Contact not found' }, { status: 400 });
  }

  const data = await convex().mutation(api.agent.questions.create, {
    spaceId: space.id,
    runId: runId ?? 'manual',
    agentType: agentType ?? 'coordinator',
    question,
    context: context ?? null,
    contactId: contactId ?? null,
    ...(typeof priority === 'number' ? { priority } : {}),
  });

  return NextResponse.json(data, { status: 201 });
}
