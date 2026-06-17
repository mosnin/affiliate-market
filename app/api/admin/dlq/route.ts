import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requirePlatformAdmin } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit } from '@/lib/rate-limit';

const VALID_STATUSES = ['pending', 'resolved', 'retrying'] as const;
type DLQStatus = (typeof VALID_STATUSES)[number];

function isValidStatus(s: string): s is DLQStatus {
  return (VALID_STATUSES as readonly string[]).includes(s);
}

/**
 * Returns true if the request carries a valid service-role key in its
 * Authorization header. Allows internal agent code to write DLQ events
 * without a Clerk session.
 */
function hasServiceRoleKey(req: Request): boolean {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return false;
  const authHeader = req.headers.get('authorization') ?? '';
  return authHeader === `Bearer ${key}`;
}

/** GET /api/admin/dlq — list DLQ events */
export async function GET(req: Request) {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const session = await auth();
  const { allowed } = await checkRateLimit(`admin:dlq:read:${session.userId}`, 60, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const { searchParams } = new URL(req.url);
  const spaceId = searchParams.get('spaceId') ?? undefined;
  const statusParam = searchParams.get('status') ?? undefined;
  const limitParam = searchParams.get('limit');
  const limit = Math.min(Math.max(1, parseInt(limitParam ?? '50', 10) || 50), 200);

  if (statusParam && !isValidStatus(statusParam)) {
    return NextResponse.json({ error: 'Invalid status. Must be pending, resolved, or retrying' }, { status: 400 });
  }

  let events;
  try {
    events = await convex().query(api.infra.deadLetter.list, {
      spaceId,
      status: statusParam as DLQStatus | undefined,
      limit,
    });
  } catch (error) {
    console.error('[admin/dlq] list query failed', error);
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }

  return NextResponse.json({ events });
}

/** POST /api/admin/dlq — create a DLQ event (platform admin or service-role key) */
export async function POST(req: Request) {
  const isServiceRole = hasServiceRoleKey(req);

  if (!isServiceRole) {
    try {
      await requirePlatformAdmin();
    } catch {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  if (!isServiceRole) {
    const session = await auth();
    const { allowed } = await checkRateLimit(`admin:dlq:write:${session.userId}`, 30, 60);
    if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  let body: { spaceId?: unknown; eventType?: unknown; payload?: unknown; error?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { spaceId, eventType, payload, error: eventError } = body;

  if (!spaceId || typeof spaceId !== 'string') {
    return NextResponse.json({ error: 'spaceId is required and must be a string' }, { status: 400 });
  }
  if (!eventType || typeof eventType !== 'string') {
    return NextResponse.json({ error: 'eventType is required and must be a string' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ error: 'payload is required and must be an object' }, { status: 400 });
  }
  if (!eventError || typeof eventError !== 'string') {
    return NextResponse.json({ error: 'error is required and must be a string' }, { status: 400 });
  }

  let event;
  try {
    event = await convex().mutation(api.infra.deadLetter.createFromAdmin, {
      spaceId,
      eventType,
      payload,
      error: eventError,
    });
  } catch (insertError) {
    console.error('[admin/dlq] insert failed', insertError);
    return NextResponse.json({ error: 'Insert failed' }, { status: 500 });
  }

  return NextResponse.json({ event }, { status: 201 });
}
