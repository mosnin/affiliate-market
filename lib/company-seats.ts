/**
 * Company seat-limit helpers (BP3b).
 *
 * "Seats in use" for a company is defined as:
 *   members (rows in CompanyMembership)
 *   + pending, non-expired invitations (Invitation.status='pending' AND expiresAt > now())
 *
 * Seat limits are driven off the Company.plan / Company.seatLimit columns.
 * The plan vocabulary and included-seat counts are the V2 source of truth in
 * lib/plans.ts:
 *   - plan:      'team' | 'team_plus'
 *   - seatLimit: integer (team=5, team_plus=10), from PLANS[plan].includedUsers
 *
 * If the plan/seatLimit columns aren't present or readable, we fall back to the
 * strictest sane default (team / 5). Never silently unlock the cap on infra
 * errors.
 */
import { convex, api } from '@/lib/convex-server';
import { PLANS } from '@/lib/plans';

export type CompanyPlan = 'team' | 'team_plus';

export interface SeatUsage {
  plan: CompanyPlan;
  seatLimit: number | null;
  /** members + pendingInvites */
  used: number;
  members: number;
  pendingInvites: number;
}

export interface SeatCheckResult {
  ok: boolean;
  usage: SeatUsage;
  /** Only set when ok === false: how many more would land the caller over the cap. */
  needed?: number;
}

const DEFAULT_PLAN: CompanyPlan = 'team';
const DEFAULT_SEAT_LIMIT = PLANS.team.includedUsers;

function isValidPlan(value: unknown): value is CompanyPlan {
  return value === 'team' || value === 'team_plus';
}

/**
 * Load plan + seatLimit for a company with pre-migration resilience.
 * If the columns don't exist yet (BP3a hasn't run), fall back to starter/5 —
 * never fall back to "unlimited" because that would silently disable the cap.
 */
async function loadPlan(
  companyId: string
): Promise<{ plan: CompanyPlan; seatLimit: number | null }> {
  try {
    const data = await convex().query(api.org.companies.getById, { id: companyId });

    if (!data) {
      return { plan: DEFAULT_PLAN, seatLimit: DEFAULT_SEAT_LIMIT };
    }

    const row = data as { plan?: unknown; seatLimit?: unknown };
    const plan: CompanyPlan = isValidPlan(row.plan) ? row.plan : DEFAULT_PLAN;

    let seatLimit: number | null;
    if (row.seatLimit === null || row.seatLimit === undefined) {
      // No explicit seatLimit on the row → fall back to the plan's included
      // seats (single source of truth in lib/plans.ts). V2 has no unlimited
      // company tier, so we never fall back to null here.
      seatLimit = PLANS[plan].includedUsers;
    } else if (typeof row.seatLimit === 'number') {
      seatLimit = row.seatLimit;
    } else {
      seatLimit = PLANS[plan].includedUsers;
    }

    return { plan, seatLimit };
  } catch {
    // Columns missing entirely (pre-migration) or other client error.
    return { plan: DEFAULT_PLAN, seatLimit: DEFAULT_SEAT_LIMIT };
  }
}

/**
 * Count CompanyMembership rows for a company.
 * Returns null on error so the caller can decide to fail-open.
 */
async function countMembers(companyId: string): Promise<number | null> {
  try {
    const { total } = await convex().query(api.org.memberships.countByCompany, { companyId });
    return total ?? 0;
  } catch {
    return null;
  }
}

/**
 * Count pending, non-expired invitations for a company.
 * Returns null on error so the caller can decide to fail-open.
 */
async function countPendingInvites(companyId: string): Promise<number | null> {
  try {
    return await convex().query(api.org.invitations.countPending, { companyId });
  } catch {
    return null;
  }
}

/**
 * Resolve current seat usage (plan + members + pending invites) for a company.
 * On infra error, counts fall back to 0 so the caller sees a "clean slate"
 * rather than a phantom overage — checkSeatCapacity() is the surface that
 * enforces fail-open semantics.
 */
export async function getSeatUsage(companyId: string): Promise<SeatUsage> {
  const [{ plan, seatLimit }, members, pendingInvites] = await Promise.all([
    loadPlan(companyId),
    countMembers(companyId),
    countPendingInvites(companyId),
  ]);

  const safeMembers = members ?? 0;
  const safePending = pendingInvites ?? 0;

  return {
    plan,
    seatLimit,
    members: safeMembers,
    pendingInvites: safePending,
    used: safeMembers + safePending,
  };
}

/**
 * Check whether `additional` new seats can be added to a company.
 *
 * Rules:
 *  - seatLimit === null → always ok (enterprise / unlimited).
 *  - used + additional <= seatLimit → ok.
 *  - Otherwise → not ok; `needed` echoes back `additional` so the UI can tell
 *    the user how many invites it was trying to send.
 *
 * Fail-closed on infra errors: if either count sub-query returned null
 * (Supabase flap), we REFUSE the invite rather than silently leak past the
 * seat cap. An earlier revision failed open under the reasoning that
 * blocking legitimate invites was worse; an audit flipped that trade-off:
 * a transient 402 during an infra incident is recoverable in seconds, a
 * silent overage against a billing cap is detected weeks later when the
 * customer reconciles their seat bill. The plan load itself still fails
 * closed to starter/5 (safe floor) so a missing `plan` column
 * (pre-migration) doesn't unlock the company.
 */
export async function checkSeatCapacity(
  companyId: string,
  additional: number
): Promise<SeatCheckResult> {
  const [{ plan, seatLimit }, membersResult, pendingResult] = await Promise.all([
    loadPlan(companyId),
    countMembers(companyId),
    countPendingInvites(companyId),
  ]);

  // Infra error on either count → fail closed.
  if (membersResult === null || pendingResult === null) {
    const requested = Math.max(0, Math.floor(additional));
    const usage: SeatUsage = {
      plan,
      seatLimit,
      members: membersResult ?? 0,
      pendingInvites: pendingResult ?? 0,
      used: (membersResult ?? 0) + (pendingResult ?? 0),
    };
    return { ok: false, usage, needed: requested };
  }

  const usage: SeatUsage = {
    plan,
    seatLimit,
    members: membersResult,
    pendingInvites: pendingResult,
    used: membersResult + pendingResult,
  };

  // Unlimited plan — always ok.
  if (seatLimit === null) {
    return { ok: true, usage };
  }

  const requested = Math.max(0, Math.floor(additional));
  if (usage.used + requested <= seatLimit) {
    return { ok: true, usage };
  }

  return { ok: false, usage, needed: requested };
}
