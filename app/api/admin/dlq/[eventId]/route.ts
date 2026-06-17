import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requirePlatformAdmin } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit } from '@/lib/rate-limit';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_THRESHOLD = 3;

type Params = { params: Promise<{ eventId: string }> };

/** GET /api/admin/dlq/[eventId] — fetch a single DLQ event */
export async function GET(_req: Request, { params }: Params) {
  try {
    await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const session = await auth();
  const { allowed } = await checkRateLimit(`admin:dlq:read:${session.userId}`, 60, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const { eventId } = await params;
  if (!eventId || !UUID_RE.test(eventId)) {
    return NextResponse.json({ error: 'Invalid event ID' }, { status: 400 });
  }

  let event;
  try {
    event = await convex().query(api.infra.deadLetter.getById, { id: eventId });
  } catch (error) {
    console.error('[admin/dlq] get single event failed', error);
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }
  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  return NextResponse.json({ event });
}

/** PATCH /api/admin/dlq/[eventId] — resolve or retry a DLQ event */
export async function PATCH(req: Request, { params }: Params) {
  let admin: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { allowed } = await checkRateLimit(`admin:dlq:write:${admin.clerkUserId}`, 30, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const { eventId } = await params;
  if (!eventId || !UUID_RE.test(eventId)) {
    return NextResponse.json({ error: 'Invalid event ID' }, { status: 400 });
  }

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { action } = body;
  if (action !== 'resolve' && action !== 'retry') {
    return NextResponse.json({ error: 'action must be resolve or retry' }, { status: 400 });
  }

  // Fetch the current event first to get retryCount
  let existing;
  try {
    existing = await convex().query(api.infra.deadLetter.getById, { id: eventId });
  } catch (fetchError) {
    console.error('[admin/dlq] fetch for patch failed', fetchError);
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  let updatePayload: { status?: 'pending' | 'retrying' | 'resolved'; resolvedAt?: string; retryCount?: number };

  if (action === 'resolve') {
    updatePayload = {
      status: 'resolved',
      resolvedAt: new Date().toISOString(),
    };
  } else {
    // retry: increment retryCount; use 'retrying' if still under threshold, else back to 'pending'
    const newRetryCount = (existing.retryCount ?? 0) + 1;
    const newStatus = newRetryCount < RETRY_THRESHOLD ? ('retrying' as const) : ('pending' as const);
    updatePayload = {
      retryCount: newRetryCount,
      status: newStatus,
    };
  }

  let event;
  try {
    event = await convex().mutation(api.infra.deadLetter.patch, {
      id: eventId,
      ...updatePayload,
    });
  } catch (updateError) {
    console.error('[admin/dlq] update failed', updateError);
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
  if (!event) {
    console.error('[admin/dlq] update failed: event vanished');
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }

  return NextResponse.json({ event });
}
