/**
 * Server-side permission resolver for the manager Cola surface
 * (`/manager/cola` → `/api/ai/manager-task`).
 *
 * This is defense layer 2 of three (per AGENTS.md and the Cola-for-Managers
 * Phase 1 spec):
 *
 *   1. ROUTE GUARD   — `app/manager/cola/page.tsx` server component
 *                      redirects when the caller isn't a manager.
 *   2. API GATE      — this module. `app/api/ai/manager-task/route.ts` calls
 *                      `resolveManagerContext()` before forwarding to Modal.
 *                      A seller_member trying to hit the manager chat —
 *                      even if they slip past the route guard somehow —
 *                      receives a 403 right here.
 *   3. TOOL-RUNTIME  — `agent/tools/manager/_guards.py:require_manager_role`
 *                      refuses tool execution unless AgentContext carries
 *                      a manager role. Phase 2/3 tools wrap every handler
 *                      body with that check.
 *
 * Layer 2 lives in its own module (not as ad-hoc code inside the route) so
 * the next route Phase 2/3 adds can reuse the same gate without copying
 * the logic — and so the contract for "what counts as manager access" is
 * single-source-of-truth.
 */

import { getManagerMemberContext } from '@/lib/permissions';
import type { Company, CompanyMembership } from '@/lib/types';

/**
 * Roles allowed to use the manager chat surface.
 *
 * `seller_member` is excluded by design — a seller inside a company
 * already has their own Cola at `/s/<slug>/cola`. The manager chat is
 * the chief-of-staff variant, scoped to company-wide operations, and
 * seller_members do not run those operations.
 */
const MANAGER_ROLES = ['manager_owner', 'manager_admin'] as const;
type ManagerRole = (typeof MANAGER_ROLES)[number];

export interface ManagerAgentContext {
  /** Company row the caller has admin/owner access to. */
  company: Company;
  /** Their CompanyMembership row — role and ids. */
  membership: CompanyMembership;
  /** Internal `User.id` (NOT Clerk id). Same shape as other helpers expose. */
  dbUserId: string;
  /** Narrowed role — guaranteed one of `MANAGER_ROLES` after this resolves. */
  managerRole: ManagerRole;
}

/**
 * Resolve the calling Clerk user to a manager-admin-or-owner context, or
 * `null` if they are not a manager.
 *
 * Returns `null` when:
 *   - The user is not signed in (no Clerk session).
 *   - The user has no `CompanyMembership` of any kind.
 *   - The user IS a company member but only as `seller_member` — the
 *     manager chat surface is not theirs.
 *   - The user's `User.status` is `offboarded` (handled inside
 *     `getManagerMemberContext` already, propagated through the null).
 *
 * On success returns the company, membership, internal user id, and a
 * narrowed `managerRole` field the caller can forward to Modal without
 * re-running its own role check.
 *
 * Reuses `getManagerMemberContext()` from `lib/permissions.ts:121` — does
 * not duplicate the membership / company / offboarding lookups, so any
 * future change to "what does manager auth mean" lives in one place.
 */
export async function resolveManagerContext(): Promise<ManagerAgentContext | null> {
  const ctx = await getManagerMemberContext();
  if (!ctx) return null;

  // `getManagerMemberContext` accepts seller_member too — it's the helper
  // for "any company member, including sellers". We filter HERE so the
  // gate exposes a single intent: the manager chat is for managers.
  const role = ctx.membership.role;
  if (role !== 'manager_owner' && role !== 'manager_admin') {
    return null;
  }

  return {
    company: ctx.company,
    membership: ctx.membership,
    dbUserId: ctx.dbUserId,
    managerRole: role,
  };
}
