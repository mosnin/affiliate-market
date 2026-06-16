import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getManagerMemberContext } from '@/lib/permissions';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { audit } from '@/lib/audit';
import { logger } from '@/lib/logger';

type Params = { params: Promise<{ id: string }> };

type TemplateCategory = 'follow-up' | 'intro' | 'closing' | 'demo-invite';
type TemplateChannel = 'sms' | 'email' | 'note';

type CompanyTemplateRow = {
  id: string;
  companyId: string;
  name: string;
  category: TemplateCategory;
  channel: TemplateChannel;
  subject: string | null;
  body: string;
  version: number;
  publishedAt: string | null;
  publishedVersion: number | null;
  publishedCount: number;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

type MembershipRow = { userId: string };
type SpaceRow = { id: string; ownerId: string };
type MessageTemplateRow = {
  id: string;
  spaceId: string;
  sourceTemplateId: string | null;
  sourceVersion: number | null;
};

const TEMPLATE_COLUMNS =
  'id, companyId, name, category, channel, subject, body, version, publishedAt, publishedVersion, publishedCount, createdByUserId, createdAt, updatedAt';

/**
 * POST /api/manager/templates/[id]/publish
 *
 * Push the current version of a CompanyTemplate out to every seller
 * member's personal MessageTemplate table. Per the BP6a contract:
 *
 *   - If an agent already has a MessageTemplate pointing at this source
 *     (sourceTemplateId = id) AND hasn't locally edited it since the last
 *     push (sourceVersion IS NOT NULL): UPDATE their row to match the new
 *     version and bump sourceVersion.
 *   - If the agent has locally edited it (sourceVersion IS NULL): SKIP —
 *     we never silently stomp on agent customisations.
 *   - If no copy exists yet: INSERT a new MessageTemplate row.
 *
 * After the per-agent loop, stamp publishedAt = now() and publishedCount =
 * (inserted + updated) on the source template.
 *
 * Supabase-js doesn't expose multi-statement transactions, so this runs as
 * a best-effort sequence of writes. Failures on individual agent rows are
 * logged and counted but don't abort the whole publish — partial success
 * is still useful, and the manager can re-publish to retry.
 *
 * Restricted to manager_owner / manager_admin.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { userId: clerkId } = await auth();

  const ctx = await getManagerMemberContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (ctx.membership.role !== 'manager_owner' && ctx.membership.role !== 'manager_admin') {
    return NextResponse.json(
      { error: 'Only the owner or admins can publish templates' },
      { status: 403 },
    );
  }

  const { id: templateId } = await params;

  // 1. Load the source template scoped to the caller's company.
  const { data: tmpl, error: loadErr } = await supabase
    .from('CompanyTemplate')
    .select(TEMPLATE_COLUMNS)
    .eq('id', templateId)
    .eq('companyId', ctx.company.id)
    .maybeSingle<CompanyTemplateRow>();

  if (loadErr) {
    logger.error(
      '[manager/templates/publish] load failed',
      { templateId, companyId: ctx.company.id },
      loadErr,
    );
    return NextResponse.json({ error: 'Failed to load template' }, { status: 500 });
  }
  if (!tmpl) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  }

  // 2. Enumerate seller_member userIds for this company. Managers don't
  //    get a personal copy — they own the source library.
  const { data: memberships, error: memberErr } = await supabase
    .from('CompanyMembership')
    .select('userId')
    .eq('companyId', ctx.company.id)
    .eq('role', 'seller_member')
    .returns<MembershipRow[]>();

  if (memberErr) {
    logger.error(
      '[manager/templates/publish] member fetch failed',
      { templateId, companyId: ctx.company.id },
      memberErr,
    );
    return NextResponse.json({ error: 'Failed to load members' }, { status: 500 });
  }

  const agentUserIds = Array.from(
    new Set(((memberships ?? []) as MembershipRow[]).map((m) => m.userId)),
  );

  // Short-circuit: no agents -> nothing to push, but we still stamp
  // publishedAt so the UI reflects "I tried". publishedCount stays 0.
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  if (agentUserIds.length > 0) {
    // 3. Resolve each agent's Space via Space.ownerId, SCOPED to this
    //    company. A seller can be a member of this company AND also
    //    own a Space in another company (dual-membership); without the
    //    companyId filter, publishing a template from Company A would
    //    fan out into Spaces in Company B — a cross-tenant data leak.
    //    0-space members (or members whose only Space is elsewhere) are
    //    counted as skipped and logged.
    const { data: spaces, error: spaceErr } = await supabase
      .from('Space')
      .select('id, ownerId')
      .in('ownerId', agentUserIds)
      .eq('companyId', ctx.company.id)
      .returns<SpaceRow[]>();

    if (spaceErr) {
      logger.error(
        '[manager/templates/publish] space fetch failed',
        { templateId, companyId: ctx.company.id },
        spaceErr,
      );
      return NextResponse.json({ error: 'Failed to load agent spaces' }, { status: 500 });
    }

    const spaceRows = (spaces ?? []) as SpaceRow[];
    const spacesByOwner = new Map<string, SpaceRow[]>();
    for (const s of spaceRows) {
      const list = spacesByOwner.get(s.ownerId) ?? [];
      list.push(s);
      spacesByOwner.set(s.ownerId, list);
    }

    // Agents with no Space — count one skip per such agent so the manager
    // can see something didn't land. No write to do for them.
    for (const userId of agentUserIds) {
      if (!spacesByOwner.has(userId)) {
        skipped += 1;
        logger.warn('[manager/templates/publish] agent has no space; skipped', {
          templateId,
          userId,
        });
      }
    }

    const targetSpaceIds = spaceRows.map((s) => s.id);

    // 4. Find existing MessageTemplate rows that trace back to this source.
    //    We only need the rows we're about to decide about, so scope the IN
    //    clause to the target spaces. If an agent happens to have multiple
    //    rows pointing at the same source (data-wise possible — no UNIQUE
    //    constraint on (spaceId, sourceTemplateId)), we treat each row
    //    independently: locally-edited ones skip, unedited ones update.
    const existingBySpace = new Map<string, MessageTemplateRow[]>();
    if (targetSpaceIds.length > 0) {
      let existing: MessageTemplateRow[];
      try {
        existing = (await convex().query(api.support.templates.findCopiesBySource, {
          sourceTemplateId: templateId,
          spaceIds: targetSpaceIds,
        })) as MessageTemplateRow[];
      } catch (existingErr) {
        logger.error(
          '[manager/templates/publish] existing fetch failed',
          { templateId, companyId: ctx.company.id },
          existingErr,
        );
        return NextResponse.json(
          { error: 'Failed to load existing copies' },
          { status: 500 },
        );
      }

      for (const row of existing) {
        const list = existingBySpace.get(row.spaceId) ?? [];
        list.push(row);
        existingBySpace.set(row.spaceId, list);
      }
    }

    // 5. Sequential writes per space. We wrap each one in its own try/catch
    //    so a single agent's failure doesn't nuke the whole publish. See
    //    the docstring for why partial success is the desired behaviour.
    for (const space of spaceRows) {
      try {
        const existing = existingBySpace.get(space.id) ?? [];

        if (existing.length === 0) {
          // No copy yet — insert a fresh one tied to this source+version.
          // (MessageTemplate has no userId column; the old insert's
          // `userId: space.ownerId` was a harmless extra key and is dropped.)
          try {
            await convex().mutation(api.support.templates.createFromSource, {
              spaceId: space.id,
              name: tmpl.name,
              channel: tmpl.channel,
              subject: tmpl.channel === 'email' ? tmpl.subject : null,
              body: tmpl.body,
              sourceTemplateId: tmpl.id,
              sourceVersion: tmpl.version,
            });
            inserted += 1;
          } catch (insertErr) {
            skipped += 1;
            logger.error(
              '[manager/templates/publish] insert failed',
              { templateId, spaceId: space.id },
              insertErr,
            );
          }
          continue;
        }

        // One or more copies exist. Update the ones that haven't been
        // locally edited (sourceVersion IS NOT NULL), skip the rest.
        for (const row of existing) {
          if (row.sourceVersion === null) {
            skipped += 1;
            logger.info(
              '[manager/templates/publish] skipped (locally edited)',
              { templateId, messageTemplateId: row.id, spaceId: space.id },
            );
            continue;
          }

          try {
            await convex().mutation(api.support.templates.updateFromSource, {
              id: row.id,
              name: tmpl.name,
              channel: tmpl.channel,
              subject: tmpl.channel === 'email' ? tmpl.subject : null,
              body: tmpl.body,
              sourceVersion: tmpl.version,
            });
            updated += 1;
          } catch (updateErr) {
            skipped += 1;
            logger.error(
              '[manager/templates/publish] update failed',
              { templateId, messageTemplateId: row.id, spaceId: space.id },
              updateErr,
            );
          }
        }
      } catch (err) {
        // Anything we didn't anticipate — log with full context and count
        // one skip so the total is honest. Don't rethrow: one bad space
        // shouldn't abandon the rest.
        skipped += 1;
        logger.error(
          '[manager/templates/publish] unexpected error for space',
          { templateId, spaceId: space.id },
          err,
        );
      }
    }
  }

  const pushed = inserted + updated;
  const publishedAt = new Date().toISOString();

  // 6. Stamp the source row. If this fails we still return the counts —
  //    the per-agent writes already landed.
  const { error: stampErr } = await supabase
    .from('CompanyTemplate')
    .update({
      publishedAt,
      // Audit follow-up: pin the exact version that was just pushed so the
      // UI can tell "up-to-date" (version === publishedVersion) from
      // "edited since last publish" (version > publishedVersion) without
      // relying on a fragile timestamp-slack heuristic.
      publishedVersion: tmpl.version,
      publishedCount: pushed,
      updatedAt: publishedAt,
    })
    .eq('id', tmpl.id)
    .eq('companyId', ctx.company.id);

  if (stampErr) {
    logger.error(
      '[manager/templates/publish] stamp failed',
      { templateId, companyId: ctx.company.id, pushed, skipped },
      stampErr,
    );
    // Don't 500 — the core publish succeeded.
  }

  void audit({
    actorClerkId: clerkId ?? null,
    action: 'UPDATE',
    resource: 'CompanyTemplate',
    resourceId: tmpl.id,
    req,
    metadata: {
      companyId: ctx.company.id,
      event: 'publish',
      version: tmpl.version,
      inserted,
      updated,
      skipped,
      pushed,
      publishedAt,
    },
  });

  return NextResponse.json({ pushed, skipped, publishedAt });
}
