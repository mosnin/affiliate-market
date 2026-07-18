import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { sendFollowUpDigest } from '@/lib/email';
import { sendSMS, followUpReminderSMS } from '@/lib/sms';
import { sendPushToSpace } from '@/lib/push';
import { redis } from '@/lib/redis';
import { monitorCron } from '@/lib/cron-monitor';

/**
 * GET /api/cron/follow-up-reminders
 *
 * Daily at 9 AM UTC. Emails + texts sellers a digest of contacts whose
 * followUpAt has come due in the last 24 hours.
 *
 * Idempotency: a SETNX day-lock prevents a duplicate cron invocation
 * (Vercel retry, manual re-trigger) from double-blasting every seller
 * with two identical "you have 3 follow-ups today" notifications.
 */
async function handler(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[cron/follow-up-reminders] CRON_SECRET env var is not set — rejecting request');
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  const authHeader = req.headers.get('Authorization');
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Day-level idempotency. The seller schedule revolves around days,
  // so locking by UTC date is the right granularity. 25h TTL absorbs
  // any clock skew or DST edge case without going stale.
  const today = new Date().toISOString().slice(0, 10);
  const lockKey = `cron-lock:follow-up-reminders:${today}`;
  const claimed = await redis.set(lockKey, '1', { nx: true, ex: 25 * 60 * 60 });
  if (claimed !== 'OK') {
    return NextResponse.json({ ok: true, skipped: 'already_ran_today', date: today });
  }

  const now = new Date();
  // Get contacts with follow-ups that are overdue or due today (within last 24h)
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  let contacts: Array<{ id: string; name: string; phone: string | null; followUpAt: string | null; spaceId: string }>;
  try {
    contacts = await convex().query(api.contacts.contacts.dueFollowUpsInWindow, {
      from: yesterday.toISOString(),
      to: now.toISOString(),
    });
  } catch (contactError) {
    console.error('[cron/follow-up-reminders] DB query failed', contactError);
    return NextResponse.json({ error: 'DB query failed' }, { status: 500 });
  }

  if (!contacts?.length) return NextResponse.json({ sent: 0 });

  // Group by spaceId
  const bySpace: Record<string, typeof contacts> = {};
  for (const c of contacts) {
    bySpace[c.spaceId] = [...(bySpace[c.spaceId] ?? []), c];
  }

  let sent = 0;
  for (const [spaceId, spaceContacts] of Object.entries(bySpace)) {
    const space = await convex().query(api.workspace.spaces.getById, { id: spaceId });
    if (!space) continue;

    const setting = await convex().query(api.workspace.settings.getBySpace, { spaceId });
    // Skip if follow-up notifications are disabled, or all channels are off
    if (setting?.notifyFollowUps === false) continue;
    if (setting?.notifications === false && setting?.smsNotifications !== true) continue;

    const user = await convex().query(api.org.users.getById, { id: space.ownerId });
    if (!user?.email) continue;

    try {
      // Email digest
      if (setting?.notifications !== false) {
        await sendFollowUpDigest({
          toEmail: user.email,
          spaceName: space.name,
          spaceSlug: space.slug,
          contacts: spaceContacts.map((c) => ({
            name: c.name,
            phone: c.phone,
            followUpAt: c.followUpAt,
          })),
        });
      }

      // SMS reminders (one per contact)
      if (setting?.smsNotifications && setting?.phoneNumber) {
        const smsPromises = spaceContacts.map((c) =>
          sendSMS(
            followUpReminderSMS({
              spaceName: space.name,
              contactName: c.name,
              phone: setting.phoneNumber!,
            })
          ).catch((err) => console.error('[cron] SMS follow-up failed', err))
        );
        await Promise.allSettled(smsPromises);
      }

      // Push reminder (one digest notification per space)
      if (setting?.notifyPush !== false) {
        const count = spaceContacts.length;
        await sendPushToSpace(spaceId, {
          title: `${count} follow-up${count === 1 ? '' : 's'} due today`,
          body:
            count === 1
              ? `Follow up with ${spaceContacts[0].name}.`
              : `Open ${space.name} to review your follow-ups.`,
          url: `/s/${space.slug}/people`,
        }).catch((err) => console.error('[cron] push follow-up failed', err));
      }

      sent++;
    } catch (err) {
      console.error('[cron/follow-up-reminders] Failed to send digest', { spaceId, error: err });
    }
  }

  return NextResponse.json({ sent });
}

export const GET = monitorCron('follow-up-reminders', { crontab: '0 9 * * *' }, handler);
