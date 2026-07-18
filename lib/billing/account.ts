/**
 * Billing-account resolution (docs/PRICING_V2_PLAN.md §4.1).
 *
 * One question, one answer: for a given space, which entity owns the plan +
 * credit balance? Solo/Pro draw from the Space; Team/Team Plus pool credits at
 * the Company. Every metering/grant call site goes through here so the
 * space-vs-company choice lives in exactly one place.
 *
 * Service-role bypasses RLS — callers must pass a `spaceId` resolved from a
 * trusted server context (the authed workspace), never raw client input.
 */

import { convex, api } from '@/lib/convex-server';
import type { PlanId } from '@/lib/plans';
import type { BillingAccount } from '@/lib/billing/credits';

export interface BillingContext {
  account: BillingAccount;
  /** The plan that governs grants/limits for this account. */
  plan: PlanId;
}

const COMPANY_PLANS = new Set<string>(['team', 'team_plus']);

/**
 * Resolve the billing account funding a space's credit spend.
 * - If the space belongs to a company on a pooled (team) plan → that
 *   company's pool.
 * - Otherwise → the space's own balance (free/solo/pro).
 */
export async function resolveBillingAccount(spaceId: string): Promise<BillingContext> {
  const space = await convex().query(api.workspace.spaces.getById, { id: spaceId });
  if (!space) throw new Error(`resolveBillingAccount: space ${spaceId} not found`);

  if (space.companyId) {
    const company = await convex().query(api.org.companies.getById, { id: space.companyId });
    if (company && COMPANY_PLANS.has(company.plan as string)) {
      // SECURITY (money routing): only pool at the company if the space's
      // owner is a VERIFIED member of it. `Space.companyId` is a loosely-set
      // field — without this check a seller could point their space at any
      // team company and drain its shared credit pool through metered work.
      const membership = await convex().query(api.org.memberships.getByCompanyUser, {
        companyId: space.companyId,
        userId: space.ownerId,
      });
      if (membership) {
        return {
          account: { type: 'company', id: company.id as string },
          plan: company.plan as PlanId,
        };
      }
    }
  }

  return {
    account: { type: 'space', id: space.id as string },
    plan: ((space.plan as string) ?? 'free') as PlanId,
  };
}
