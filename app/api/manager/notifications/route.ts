import { NextResponse } from 'next/server';
import { requireManager } from '@/lib/permissions';
import { convex, api } from '@/lib/convex-server';

/**
 * GET /api/manager/notifications
 * Returns the latest manager notifications.
 */
export async function GET() {
  let ctx;
  try {
    ctx = await requireManager();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const notifications = await convex().query(api.notifications.manager.listByCompany, {
    companyId: ctx.company.id,
    limit: 20,
  });

  return NextResponse.json({ notifications });
}

/**
 * PATCH /api/manager/notifications
 * Mark all unread notifications as read.
 */
export async function PATCH() {
  let ctx;
  try {
    ctx = await requireManager();
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await convex().mutation(api.notifications.manager.markAllRead, {
    companyId: ctx.company.id,
  });

  return NextResponse.json({ success: true });
}
