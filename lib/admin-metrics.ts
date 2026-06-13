/**
 * Operator business metrics — the platform's own P&L view.
 *
 * Cola earns three ways and this module measures all three from the source
 * ledgers, read-only, server-side:
 *   1. Seller subscriptions  → MRR (Space plans solo/pro; Company plans team/team_plus)
 *   2. Creator affiliate fees → the flat 20% platform cut on creator earnings
 *   3. Marketplace GMV        → gross merchandise value of paid software sales
 *
 * Every number is a live SELECT over the canonical tables — no derived caches
 * to drift. Each function is wrapped so a partial/empty DB returns zeros
 * instead of throwing; the page must never 500 on missing data.
 *
 * Money convention: everything here is OPERATOR-facing, so amounts are gross
 * platform economics (what Cola bills / takes), expressed in integer cents.
 */

import { supabase } from '@/lib/supabase';
import { PLANS, type PlanId } from '@/lib/plans';

/** Subscription states that count as live revenue. Trialing is included
 *  because a trial converts to MRR by default; the page also surfaces the
 *  trialing slice on its own so the operator can read conversion risk. */
const LIVE_STATUSES = ['active', 'trialing'] as const;

/** States that signal a subscription is failing or gone. */
const AT_RISK_STATUSES = ['past_due', 'canceled', 'unpaid'] as const;

/** Plan ids whose balance lives on the Space (solo/pro are paid; free is $0). */
const SPACE_PAID_PLANS: PlanId[] = ['solo', 'pro'];
/** Plan ids whose balance lives on the Company. */
const COMPANY_PAID_PLANS: PlanId[] = ['team', 'team_plus'];

/** Monthly price in cents for a plan id, or 0 if the id isn't a known paid tier. */
function planMrrCents(plan: string | null | undefined): number {
  const def = plan ? PLANS[plan as PlanId] : undefined;
  return def ? def.priceMonthly * 100 : 0;
}

export interface TierBreakdownRow {
  tier: PlanId;
  label: string;
  count: number;
  mrrCents: number;
}

export interface SubscriptionBreakdown {
  tiers: TierBreakdownRow[];
  statusCounts: {
    active: number;
    trialing: number;
    past_due: number;
    canceled: number;
  };
  /** Subscriptions on a live (active|trialing) status across Space + Company. */
  activeCount: number;
}

export interface MrrResult {
  mrrCents: number;
  /** Live (active|trialing) paid subscriptions contributing to MRR. */
  activeSubscriptions: number;
  perTier: TierBreakdownRow[];
}

type SubRow = { plan: string | null; stripeSubscriptionStatus: string | null };

/**
 * Pull every Space and Company subscription row once. Both surfaces share the
 * same shape (plan + status), so callers can aggregate them uniformly.
 * Returns empty arrays on any error so downstream math is always safe.
 */
async function loadSubscriptionRows(): Promise<{ spaces: SubRow[]; companies: SubRow[] }> {
  try {
    const [spacesRes, companiesRes] = await Promise.all([
      supabase.from('Space').select('plan, stripeSubscriptionStatus'),
      supabase.from('Company').select('plan, stripeSubscriptionStatus'),
    ]);
    return {
      spaces: (spacesRes.data as SubRow[] | null) ?? [],
      companies: (companiesRes.data as SubRow[] | null) ?? [],
    };
  } catch {
    return { spaces: [], companies: [] };
  }
}

/**
 * MRR = Σ planPrice over every Space (solo/pro) and Company (team/team_plus)
 * whose subscription is active or trialing. Free spaces price to $0 and so
 * never move the number; canceled/past_due/unpaid are excluded entirely.
 * The plan→price map is PLANS (lib/plans.ts) — the single pricing source.
 */
export async function getMrrCents(): Promise<MrrResult> {
  try {
    const { spaces, companies } = await loadSubscriptionRows();

    const counts = new Map<PlanId, { count: number; mrrCents: number }>();
    const bump = (plan: PlanId, cents: number) => {
      const cur = counts.get(plan) ?? { count: 0, mrrCents: 0 };
      cur.count += 1;
      cur.mrrCents += cents;
      counts.set(plan, cur);
    };

    let mrrCents = 0;
    let activeSubscriptions = 0;

    const tally = (rows: SubRow[], allowed: PlanId[]) => {
      for (const r of rows) {
        if (!LIVE_STATUSES.includes(r.stripeSubscriptionStatus as never)) continue;
        const plan = r.plan as PlanId;
        if (!allowed.includes(plan)) continue; // skips free + any legacy value
        const cents = planMrrCents(plan);
        if (cents <= 0) continue; // paid tiers only
        mrrCents += cents;
        activeSubscriptions += 1;
        bump(plan, cents);
      }
    };

    tally(spaces, SPACE_PAID_PLANS);
    tally(companies, COMPANY_PAID_PLANS);

    const perTier: TierBreakdownRow[] = [...SPACE_PAID_PLANS, ...COMPANY_PAID_PLANS].map(
      (tier) => ({
        tier,
        label: PLANS[tier].label,
        count: counts.get(tier)?.count ?? 0,
        mrrCents: counts.get(tier)?.mrrCents ?? 0,
      }),
    );

    return { mrrCents, activeSubscriptions, perTier };
  } catch {
    return { mrrCents: 0, activeSubscriptions: 0, perTier: [] };
  }
}

/**
 * Per-tier counts + MRR, plus a status census (active/trialing/past_due/
 * canceled) across both subscription surfaces. Powers the breakdown table
 * and the health card.
 */
export async function getSubscriptionBreakdown(): Promise<SubscriptionBreakdown> {
  const empty: SubscriptionBreakdown = {
    tiers: [],
    statusCounts: { active: 0, trialing: 0, past_due: 0, canceled: 0 },
    activeCount: 0,
  };
  try {
    const { spaces, companies } = await loadSubscriptionRows();
    const all = [...spaces, ...companies];

    const statusCounts = { active: 0, trialing: 0, past_due: 0, canceled: 0 };
    for (const r of all) {
      const s = r.stripeSubscriptionStatus;
      if (s === 'active') statusCounts.active += 1;
      else if (s === 'trialing') statusCounts.trialing += 1;
      else if (s === 'past_due') statusCounts.past_due += 1;
      else if (s === 'canceled') statusCounts.canceled += 1;
    }

    const { perTier, activeSubscriptions } = await getMrrCents();

    return { tiers: perTier, statusCounts, activeCount: activeSubscriptions };
  } catch {
    return empty;
  }
}

export interface GmvResult {
  gmvCents: number;
  orderCount: number;
}

/**
 * GMV = Σ MarketplaceOrder.amountCents where status = 'paid'. With window
 * '30d', restricts to orders whose paidAt is within the last 30 days
 * (falling back to createdAt when paidAt is null). 'all' sums every paid order.
 */
export async function getGmvCents(window: '30d' | 'all' = 'all'): Promise<GmvResult> {
  try {
    const since =
      window === '30d'
        ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
        : null;

    const { data, error } = await supabase
      .from('MarketplaceOrder')
      .select('amountCents, paidAt, createdAt, status')
      .eq('status', 'paid');

    if (error || !data) return { gmvCents: 0, orderCount: 0 };

    const rows = (data as { amountCents: number | null; paidAt: string | null; createdAt: string | null }[]).filter(
      (o) => {
        if (!since) return true;
        const when = o.paidAt ?? o.createdAt;
        return when ? when >= since : false;
      },
    );

    const gmvCents = rows.reduce((sum, o) => sum + (o.amountCents ?? 0), 0);
    return { gmvCents, orderCount: rows.length };
  } catch {
    return { gmvCents: 0, orderCount: 0 };
  }
}

export interface PlatformRevenueResult {
  /** Total platform take: affiliate fees + marketplace GMV fee. */
  totalCents: number;
  /** The flat 20% cut Cola earns on creator earnings (approved + paid). */
  affiliateFeeCents: number;
  /** Marketplace GMV fee — 0 until the platformGmvFeeCents column exists. */
  gmvFeeCents: number;
}

/**
 * Platform revenue = the affiliate platform fee (Σ AffiliateCommission
 * .platformFeeCents where status in approved/paid) plus a marketplace GMV fee.
 *
 * The GMV-fee column (MarketplaceOrder.platformGmvFeeCents) may not exist yet:
 * we probe it with a narrow select and, if PostgREST rejects the unknown
 * column, fall back to 0 — the revenue number stays correct rather than 500ing.
 */
export async function getPlatformRevenueCents(): Promise<PlatformRevenueResult> {
  let affiliateFeeCents = 0;
  let gmvFeeCents = 0;

  // Affiliate platform fees — the 20% cut, on commissions that are earned.
  try {
    const { data, error } = await supabase
      .from('AffiliateCommission')
      .select('platformFeeCents, status');
    if (!error && data) {
      affiliateFeeCents = (data as { platformFeeCents: number | null; status: string }[])
        .filter((c) => c.status === 'approved' || c.status === 'paid')
        .reduce((sum, c) => sum + (c.platformFeeCents ?? 0), 0);
    }
  } catch {
    affiliateFeeCents = 0;
  }

  // Marketplace GMV fee — defensive: the column is not in the schema today.
  // A select on a missing column returns a PostgREST error (it does not throw),
  // so we branch on `error` AND wrap in try/catch, and only sum paid orders.
  try {
    const { data, error } = await supabase
      .from('MarketplaceOrder')
      .select('platformGmvFeeCents, status')
      .eq('status', 'paid');
    if (!error && data) {
      gmvFeeCents = (data as { platformGmvFeeCents: number | null }[]).reduce(
        (sum, o) => sum + (o.platformGmvFeeCents ?? 0),
        0,
      );
    }
    // error (e.g. column does not exist) → leave gmvFeeCents at 0.
  } catch {
    gmvFeeCents = 0;
  }

  return {
    totalCents: affiliateFeeCents + gmvFeeCents,
    affiliateFeeCents,
    gmvFeeCents,
  };
}

export interface ChurnSignals {
  /** Subscriptions in past_due/canceled/unpaid right now (Space + Company). */
  atRiskCount: number;
  /** Subscriptions currently trialing — conversion still pending. */
  trialingCount: number;
  pastDueCount: number;
  canceledCount: number;
  unpaidCount: number;
}

/**
 * At-risk / churned subscriptions: count of Spaces + Companies whose status is
 * past_due, canceled, or unpaid. The subscription tables carry no
 * status-changed-at column, so this is a current-state census (not a windowed
 * rate) — labelled "at-risk / churned" in the UI to match that meaning.
 */
export async function getChurnSignals(): Promise<ChurnSignals> {
  const empty: ChurnSignals = {
    atRiskCount: 0,
    trialingCount: 0,
    pastDueCount: 0,
    canceledCount: 0,
    unpaidCount: 0,
  };
  try {
    const { spaces, companies } = await loadSubscriptionRows();
    const all = [...spaces, ...companies];

    let pastDueCount = 0;
    let canceledCount = 0;
    let unpaidCount = 0;
    let trialingCount = 0;

    for (const r of all) {
      const s = r.stripeSubscriptionStatus;
      if (s === 'past_due') pastDueCount += 1;
      else if (s === 'canceled') canceledCount += 1;
      else if (s === 'unpaid') unpaidCount += 1;
      else if (s === 'trialing') trialingCount += 1;
    }

    const atRiskCount = AT_RISK_STATUSES.reduce((n, status) => {
      if (status === 'past_due') return n + pastDueCount;
      if (status === 'canceled') return n + canceledCount;
      if (status === 'unpaid') return n + unpaidCount;
      return n;
    }, 0);

    return { atRiskCount, trialingCount, pastDueCount, canceledCount, unpaidCount };
  } catch {
    return empty;
  }
}
