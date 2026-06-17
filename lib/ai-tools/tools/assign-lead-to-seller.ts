/**
 * `assign_lead_to_seller` — manager reassigns a Contact to a seller.
 *
 * Approval-gated. Manager-only. Mirrors the assignment record-keeping in
 * `app/api/manager/assign-lead/route.ts` (audit metadata in
 * applicationStatusNote, plus a 'note' ContactActivity entry), but
 * intentionally narrower: we update the existing Contact row's audit fields
 * — we do NOT clone the contact into another seller's space here. The
 * route does the clone for first-time assignment from the manager's intake
 * pool. This tool reassigns an already-owned lead within the company,
 * which is a smaller operation. Cloning/notification is what the
 * assign-lead route exists for; the agent should call that surface for
 * first-touch lead drops, not this tool.
 *
 * Note: Contact has no `assignedToUserId` column — assignment is recorded
 * via tags + applicationStatusNote (canonical) and the activity note
 * (audit trail). That's the existing convention.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';
import { defineTool } from '../types';

const parameters = z
  .object({
    personId: z.string().min(1).describe('Contact.id to reassign.'),
    sellerUserId: z.string().min(1).describe('User.id of the new owner seller.'),
    why: z.string().trim().min(1).max(280).describe('Reassignment reason — appears in the activity log.'),
  })
  .describe('Reassign a Contact to a different seller in the same company.');

interface AssignResult {
  contactId: string;
  sellerUserId: string;
  sellerName: string;
}

export const assignLeadToSellerTool = defineTool<typeof parameters, AssignResult>({
  name: 'assign_lead_to_seller',
  riskLevel: 'low',
  description:
    'Manager-only. Reassign a Contact to a different seller in the same company. Prompts for approval.',
  parameters,
  requiresApproval: true,
  rateLimit: { max: 60, windowSeconds: 3600 },
  summariseCall(args) {
    return `Reassign contact ${args.personId.slice(0, 8)} → seller ${args.sellerUserId.slice(0, 8)}: ${args.why}`;
  },

  async handler(args, ctx) {
    // ── Manager-role gate ────────────────────────────────────────────────────
    let callerUser: { id: string } | null = null;
    try {
      callerUser = await convex().query(api.org.users.getByClerkId, { clerkId: ctx.userId });
    } catch {
      callerUser = null;
    }
    if (!callerUser) {
      return { summary: 'Manager access required.', display: 'error' };
    }
    let callerMemberships: Array<{ companyId: string }> = [];
    try {
      callerMemberships = await convex().query(api.org.memberships.listByUser, {
        userId: callerUser.id,
        roles: ['manager_owner', 'manager_admin'],
      });
    } catch {
      callerMemberships = [];
    }
    const callerCompanyIds = new Set(callerMemberships.map((m) => m.companyId));
    if (callerCompanyIds.size === 0) {
      return { summary: 'Manager access required.', display: 'error' };
    }

    // ── Seller must be in the same company ──────────────────────────────
    // The old code used `.eq('userId').maybeSingle()` (one membership per
    // seller); listByUser returns the set — take the first to mirror that.
    let sellerMembership: { companyId: string; userId: string } | null = null;
    try {
      const sellerMemberships = await convex().query(api.org.memberships.listByUser, {
        userId: args.sellerUserId,
      });
      sellerMembership = sellerMemberships[0] ?? null;
    } catch {
      sellerMembership = null;
    }
    if (!sellerMembership || !callerCompanyIds.has(sellerMembership.companyId)) {
      return { summary: 'That seller is not in your company.', display: 'error' };
    }

    // ── Contact must exist (in this space OR linked to the company) ──────
    // Unscoped lookup by id (the old `.eq('id').maybeSingle()` with no
    // spaceId) — omit spaceId so getById returns the row regardless of space.
    let contact: { id: string; name: string; spaceId: string; companyId: string | null } | null;
    try {
      contact = await convex().query(api.contacts.contacts.getById, { id: args.personId });
    } catch {
      contact = null;
    }
    if (!contact) {
      return { summary: 'Contact not found.', display: 'error' };
    }
    const c = contact as { id: string; name: string; spaceId: string; companyId: string | null };
    const companyId = sellerMembership.companyId;
    const callerOwnsThisContact = c.spaceId === ctx.space.id || c.companyId === companyId;
    if (!callerOwnsThisContact) {
      return { summary: 'Contact not in your company.', display: 'error' };
    }

    // ── Fetch seller name for the audit note ──────────────────────────────
    let seller: { id: string; name?: string | null; email?: string | null } | null = null;
    try {
      seller = await convex().query(api.org.users.getById, { id: args.sellerUserId });
    } catch {
      seller = null;
    }
    const sellerName =
      seller?.name ??
      seller?.email ??
      args.sellerUserId;

    // ── Audit-only update: applicationStatusNote + activity note. No clone.
    const now = new Date().toISOString();
    const meta = JSON.stringify({
      assignedTo: args.sellerUserId,
      assignedToName: sellerName,
      assignedAt: now,
      via: 'on_demand_agent',
      reason: args.why,
    });

    // Scope the UPDATE by the specific ownership leg we just proved at
    // L98 — either the contact lives in the manager's own space, or it's
    // linked to a company the caller administers. The read-then-write
    // pattern is safe only if the write carries the same scope; a
    // concurrent manager-merge or reassign-elsewhere could otherwise let
    // the UPDATE land on a row that has since moved out of scope. The
    // update mutation enforces the same CAS via its spaceId/companyId args
    // (returns null on scope mismatch).
    try {
      const updated = await convex().mutation(api.contacts.contacts.update, {
        id: c.id,
        ...(c.spaceId === ctx.space.id
          ? { spaceId: ctx.space.id }
          : { companyId }),
        patch: { applicationStatusNote: meta },
        updatedAt: now,
      });
      if (!updated) {
        logger.error('[tools.assign_lead] update missed scope', { contactId: c.id });
        return { summary: 'Reassignment failed: contact moved out of scope.', display: 'error' };
      }
    } catch (updateErr) {
      logger.error('[tools.assign_lead] update failed', { contactId: c.id }, updateErr);
      const message = updateErr instanceof Error ? updateErr.message : 'unknown error';
      return { summary: `Reassignment failed: ${message}`, display: 'error' };
    }

    try {
      await convex().mutation(api.contacts.activity.create, {
        id: crypto.randomUUID(),
        contactId: c.id,
        spaceId: c.spaceId,
        type: 'note',
        content: `Reassigned to ${sellerName}: ${args.why}`,
        metadata: { sellerUserId: args.sellerUserId, via: 'on_demand_agent' },
      });
    } catch (activityErr) {
      logger.warn('[tools.assign_lead] activity insert failed', { contactId: c.id }, activityErr);
    }

    return {
      summary: `Reassigned ${c.name} to ${sellerName}.`,
      data: { contactId: c.id, sellerUserId: args.sellerUserId, sellerName },
      display: 'success',
    };
  },
});
