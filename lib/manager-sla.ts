/**
 * Speed-to-lead enforcement — the agentic half of company lead routing.
 *
 * Routing already puts a lead in a seller's hands (auto-assign + DealRoutingRule
 * → a Contact clone tagged `assigned-by-manager` in the seller's space). This is
 * the part that makes sure it's actually WORKED: a sweep that finds routed leads
 * sitting un-touched past the company's SLA and acts on the manager's behalf —
 * nudging the seller first, escalating to the manager if it stays cold.
 *
 * Detection needs no extra schema:
 *   - a routed lead  = Contact in a member space tagged `assigned-by-manager`
 *   - un-worked      = `lastContactedAt IS NULL`
 *   - the clock      = the clone's `createdAt` (= assignment time)
 *
 * Idempotency is carried on the contact's own tags: once Cola nudges it gets
 * `sla-nudged`; once it escalates it gets `sla-escalated`. The sweep skips a
 * lead it has already acted on at that level, so running every 15 minutes never
 * double-pings.
 */

import { convex, api } from '@/lib/convex-server';
import { getCompanyMembers } from '@/lib/company-members';
import { notifyManager } from '@/lib/manager-notify';
import { sendPushToSpace } from '@/lib/push';
import { logger } from '@/lib/logger';

export interface CompanySlaPolicy {
  id: string;
  name: string;
  slaFirstResponseMinutes: number;
  slaEscalateMinutes: number;
}

export interface SlaSweepResult {
  companyId: string;
  breached: number;
  nudged: number;
  escalated: number;
}

const NUDGED_TAG = 'sla-nudged';
const ESCALATED_TAG = 'sla-escalated';

function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

/**
 * Run the speed-to-lead sweep for one company. Best-effort throughout — a
 * single contact failing never aborts the rest. Returns what Cola did.
 */
export async function sweepCompanySla(company: CompanySlaPolicy): Promise<SlaSweepResult> {
  const result: SlaSweepResult = { companyId: company.id, breached: 0, nudged: 0, escalated: 0 };

  // ── Member spaces + seller names ──────────────────────────────────────────
  const members = await getCompanyMembers(company.id, { includeSpaceName: true });
  const spaceIds: string[] = [];
  const spaceToSeller = new Map<string, string>();
  for (const m of members) {
    const sid = m.Space?.id;
    if (!sid) continue;
    spaceIds.push(sid);
    spaceToSeller.set(sid, m.User?.name ?? m.User?.email ?? 'a seller');
  }
  if (spaceIds.length === 0) return result;

  // First-response threshold: any routed lead created before this has now sat
  // longer than the company allows.
  const firstThreshold = new Date(Date.now() - company.slaFirstResponseMinutes * 60000).toISOString();

  let data;
  try {
    data = await convex().query(api.contacts.contacts.filterForSpaces, {
      spaceIds,
      tagsAll: ['assigned-by-manager'],
      lastContactedNull: true,
      createdLte: firstThreshold,
      limit: 2000,
    });
  } catch (error) {
    logger.error('[manager-sla] breach query failed', { companyId: company.id }, error);
    return result;
  }

  const rows = (data ?? []) as {
    id: string;
    name: string;
    spaceId: string;
    tags: string[] | null;
    createdAt: string;
  }[];

  for (const c of rows) {
    const tags = c.tags ?? [];
    const waited = minutesSince(c.createdAt);
    const seller = spaceToSeller.get(c.spaceId) ?? 'a seller';
    result.breached += 1;

    try {
      // Past the escalation window → the seller has had their chance; pull in
      // the manager (their decision whether to reassign — nothing fires without
      // a human's name on it).
      if (waited >= company.slaEscalateMinutes) {
        if (tags.includes(ESCALATED_TAG)) continue;
        await notifyManager({
          companyId: company.id,
          type: 'review_requested',
          title: `${c.name} still hasn't been contacted`,
          body: `Assigned to ${seller} ${waited} minutes ago and still no first response. Reassign or step in.`,
          metadata: { kind: 'lead_sla_breach', contactId: c.id, spaceId: c.spaceId, seller, waitedMinutes: waited },
        });
        await convex().mutation(api.contacts.contacts.update, {
          id: c.id,
          patch: { tags: [...tags, ESCALATED_TAG] },
        });
        result.escalated += 1;
        continue;
      }

      // Past first-response but inside the escalation window → nudge the seller.
      if (tags.includes(NUDGED_TAG)) continue;
      await sendPushToSpace(c.spaceId, {
        title: 'A lead is waiting on you',
        body: `${c.name} has been waiting ${waited} minutes. Reach out now.`,
      }).catch(() => 0);
      await convex().mutation(api.contacts.contacts.update, {
        id: c.id,
        patch: { tags: [...tags, NUDGED_TAG] },
      });
      result.nudged += 1;
    } catch (err) {
      logger.warn('[manager-sla] action failed for contact', { companyId: company.id, contactId: c.id }, err);
    }
  }

  return result;
}

/**
 * Run the sweep for every company that has SLA enforcement on. Used by the
 * cron route.
 */
export async function sweepAllCompanies(): Promise<SlaSweepResult[]> {
  let all;
  try {
    all = await convex().query(api.org.companies.listAll, {});
  } catch (error) {
    logger.error('[manager-sla] failed to load companies', {}, error);
    return [];
  }
  // No slaEnabled-specific index exists; listAll returns every company and we
  // keep only those with SLA enforcement on (the old `.eq('slaEnabled', true)`).
  const policies = ((all ?? []) as Array<CompanySlaPolicy & { slaEnabled?: boolean }>)
    .filter((c) => c.slaEnabled === true)
    .map((c) => ({
      id: c.id,
      name: c.name,
      slaFirstResponseMinutes: c.slaFirstResponseMinutes,
      slaEscalateMinutes: c.slaEscalateMinutes,
    }));
  const out: SlaSweepResult[] = [];
  for (const p of policies) {
    try {
      out.push(await sweepCompanySla(p));
    } catch (err) {
      logger.error('[manager-sla] company sweep threw', { companyId: p.id }, err);
    }
  }
  return out;
}
