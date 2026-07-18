/**
 * `summarize_seller` — manager-only rollup of one seller's recent activity.
 *
 * Read-only. Gated on the caller having a manager_owner / manager_admin
 * CompanyMembership for the seller's company. The check mirrors the
 * existing pattern in `lib/permissions.ts` (CompanyMembership row with
 * role IN ('manager_owner','manager_admin')) but operates on `ctx.userId`
 * (Clerk) rather than going through `auth()` since tools have ctx pre-resolved.
 *
 * Returns: deals (active/won/lost), contacts (newPersons/hotPersons), drafts
 * (pending/sent/approvalRate). All scoped to the seller's space + windowDays.
 */

import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import { convex, api } from '@/lib/convex-server';
import { defineTool } from '../types';

const parameters = z
  .object({
    sellerUserId: z.string().min(1).describe('User.id of the seller to summarise.'),
    windowDays: z.number().int().min(1).max(90).optional().default(7),
  })
  .describe('Roll up one seller\'s recent activity. Manager access required.');

interface SummarizeSellerResult {
  seller: { name: string | null; email: string };
  deals: { active: number; won: number; lost: number };
  contacts: { newPersons: number; hotPersons: number };
  drafts: { pending: number; sent: number; approvalRate: number | null };
}

export const summarizeSellerTool = defineTool<typeof parameters, SummarizeSellerResult>({
  name: 'summarize_seller',
  riskLevel: 'safe',
  description:
    'Manager-only. Roll up one seller\'s deals, contacts, and drafts over the last N days (default 7).',
  parameters,
  requiresApproval: false,

  async handler(args, ctx) {
    // ── Caller must be manager_owner / manager_admin somewhere ────────────────
    const { data: callerUser } = await supabase
      .from('User')
      .select('id')
      .eq('clerkId', ctx.userId)
      .maybeSingle();
    if (!callerUser) {
      return { summary: 'Manager access required.', display: 'error' };
    }
    const { data: callerMemberships } = await supabase
      .from('CompanyMembership')
      .select('companyId, role')
      .eq('userId', (callerUser as { id: string }).id)
      .in('role', ['manager_owner', 'manager_admin']);
    const callerCompanyIds = new Set(
      ((callerMemberships ?? []) as Array<{ companyId: string }>).map((m) => m.companyId),
    );
    if (callerCompanyIds.size === 0) {
      return { summary: 'Manager access required.', display: 'error' };
    }

    // ── Seller must be in one of the caller's companies ───────────────────
    const { data: sellerMembership } = await supabase
      .from('CompanyMembership')
      .select('companyId, userId')
      .eq('userId', args.sellerUserId)
      .maybeSingle();
    if (!sellerMembership) {
      return { summary: 'That user is not a company member.', display: 'error' };
    }
    if (!callerCompanyIds.has((sellerMembership as { companyId: string }).companyId)) {
      return { summary: 'Manager access required for that seller.', display: 'error' };
    }

    // ── Fetch seller profile + their space ────────────────────────────────
    const [{ data: seller }, { data: space }] = await Promise.all([
      supabase
        .from('User')
        .select('id, name, email')
        .eq('id', args.sellerUserId)
        .maybeSingle(),
      supabase
        .from('Space')
        .select('id')
        .eq('ownerId', args.sellerUserId)
        .maybeSingle(),
    ]);
    if (!seller) {
      return { summary: 'Seller not found.', display: 'error' };
    }
    if (!space) {
      return {
        summary: `${(seller as { name: string | null }).name ?? 'Seller'} has no workspace yet.`,
        display: 'error',
      };
    }
    const spaceId = (space as { id: string }).id;

    const windowDays = args.windowDays ?? 7;
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

    // ── Pull aggregates in parallel. We over-select where the count matters
    //    little (drafts) and use head:false counts where it doesn't.
    const [dealsRes, newContactsRes, hotContactsRes, draftsRes] = await Promise.all([
      supabase
        .from('Deal')
        .select('status, updatedAt')
        .eq('spaceId', spaceId)
        .gte('updatedAt', since),
      supabase
        .from('Contact')
        .select('id', { count: 'exact', head: true })
        .eq('spaceId', spaceId)
        .is('companyId', null)
        .gte('createdAt', since),
      supabase
        .from('Contact')
        .select('id', { count: 'exact', head: true })
        .eq('spaceId', spaceId)
        .is('companyId', null)
        .eq('scoreLabel', 'hot'),
      convex().query(api.agent.drafts.statusesForSpaceSince, { spaceId, since }),
    ]);

    const dealRows = (dealsRes.data ?? []) as Array<{ status: string }>;
    const deals = {
      active: dealRows.filter((d) => d.status === 'active').length,
      won: dealRows.filter((d) => d.status === 'won').length,
      lost: dealRows.filter((d) => d.status === 'lost').length,
    };

    const draftRows = (draftsRes ?? []) as Array<{ status: string }>;
    const pending = draftRows.filter((d) => d.status === 'pending').length;
    const sent = draftRows.filter((d) => d.status === 'sent').length;
    const decided = draftRows.filter((d) => d.status === 'sent' || d.status === 'dismissed').length;
    const approvalRate = decided === 0 ? null : sent / decided;

    const profile = seller as { name: string | null; email: string };
    const result: SummarizeSellerResult = {
      seller: { name: profile.name, email: profile.email },
      deals,
      contacts: {
        newPersons: newContactsRes.count ?? 0,
        hotPersons: hotContactsRes.count ?? 0,
      },
      drafts: { pending, sent, approvalRate },
    };

    return {
      summary: `${profile.name ?? profile.email}: ${deals.active} active, ${deals.won} won, ${result.contacts.newPersons} new, ${pending} pending drafts.`,
      data: result,
      display: 'plain',
    };
  },
});
