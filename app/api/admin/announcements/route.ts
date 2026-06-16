import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';
import { logAdminAction } from '@/lib/admin';
import { checkRateLimit } from '@/lib/rate-limit';

const SEVERITIES = ['info', 'warning', 'critical'] as const;
const SEGMENTS = ['all', 'trial', 'active', 'past_due', 'admin'] as const;
type Severity = (typeof SEVERITIES)[number];
type Segment = (typeof SEGMENTS)[number];

function validateBody(body: any): { ok: true; data: any } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid body' };
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length < 1 || message.length > 500) {
    return { ok: false, error: 'message must be 1-500 chars' };
  }
  const title = body.title === undefined || body.title === null ? null : String(body.title).trim();
  if (title !== null && title.length > 100) return { ok: false, error: 'title must be 0-100 chars' };
  const severity = body.severity as Severity;
  if (!SEVERITIES.includes(severity)) return { ok: false, error: 'Invalid severity' };
  const targetSegment = body.targetSegment as Segment;
  if (!SEGMENTS.includes(targetSegment)) return { ok: false, error: 'Invalid targetSegment' };
  const linkUrl = body.linkUrl ? String(body.linkUrl).trim() : null;
  const linkLabel = body.linkLabel ? String(body.linkLabel).trim() : null;
  if (linkUrl && linkUrl.length > 500) return { ok: false, error: 'linkUrl too long' };
  if (linkLabel && linkLabel.length > 100) return { ok: false, error: 'linkLabel too long' };
  const dismissible = body.dismissible !== false;
  const active = body.active !== false;
  const startsAt = body.startsAt ? new Date(body.startsAt).toISOString() : null;
  const endsAt = body.endsAt ? new Date(body.endsAt).toISOString() : null;
  return {
    ok: true,
    data: { message, title: title || null, severity, targetSegment, linkUrl, linkLabel, dismissible, active, startsAt, endsAt },
  };
}

/** GET /api/admin/announcements — list all announcements (admin only) */
export async function GET() {
  let admin: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { allowed } = await checkRateLimit(`admin:read:${admin.clerkUserId}`, 60, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  let data;
  try {
    data = await convex().query(api.notifications.announcements.listAll, { limit: 100 });
  } catch (error) {
    console.error('[admin/announcements] list failed', error);
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }
  return NextResponse.json({ announcements: data });
}

/** POST /api/admin/announcements — create */
export async function POST(req: Request) {
  let admin: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { allowed } = await checkRateLimit(`admin:${admin.clerkUserId}`, 30, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const v = validateBody(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  let data;
  try {
    data = await convex().mutation(api.notifications.announcements.create, {
      message: v.data.message,
      title: v.data.title,
      severity: v.data.severity,
      targetSegment: v.data.targetSegment,
      linkUrl: v.data.linkUrl,
      linkLabel: v.data.linkLabel,
      dismissible: v.data.dismissible,
      active: v.data.active,
      startsAt: v.data.startsAt,
      endsAt: v.data.endsAt,
      createdBy: admin.clerkUserId,
    });
  } catch (error) {
    console.error('[admin/announcements] create failed', error);
    return NextResponse.json({ error: 'Create failed' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Create failed' }, { status: 500 });
  }

  await logAdminAction({
    actor: admin.clerkUserId,
    action: 'create_announcement',
    target: data.id,
    details: { severity: v.data.severity, targetSegment: v.data.targetSegment },
  });

  return NextResponse.json({ announcement: data });
}

/** DELETE /api/admin/announcements?id=... */
export async function DELETE(req: Request) {
  let admin: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { allowed } = await checkRateLimit(`admin:${admin.clerkUserId}`, 30, 60);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
  }

  try {
    await convex().mutation(api.notifications.announcements.remove, { id });
  } catch (error) {
    console.error('[admin/announcements] delete failed', error);
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }

  await logAdminAction({ actor: admin.clerkUserId, action: 'delete_announcement', target: id });
  return NextResponse.json({ message: 'Deleted' });
}
