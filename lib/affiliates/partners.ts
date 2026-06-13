import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { getOrCreateDefaultProgram } from '@/lib/affiliates/programs';
import { createLink } from '@/lib/affiliates/links';
import { sendPartnerApprovedEmail, sendPartnerInvitedEmail } from '@/lib/affiliates/emails';

export type PartnerStatus = 'pending' | 'approved' | 'suspended';

export interface AffiliatePartnerRow {
  id: string;
  spaceId: string;
  programId: string;
  name: string;
  email: string;
  clerkUserId: string | null;
  status: PartnerStatus;
  payoutMethod: string | null;
  payoutDetails: Record<string, unknown> | null;
  /** Stripe Connect (Express) account that receives this creator's payouts. */
  stripeAccountId: string | null;
  createdAt: string;
}

export interface PartnerWithStats {
  id: string;
  name: string;
  email: string;
  status: PartnerStatus;
  createdAt: string;
  clicks: number;
  customers: number;
  earnedCents: number;
}

export interface CreatePartnerInput {
  spaceId: string;
  name: string;
  email: string;
  clerkUserId?: string | null;
  /** True when a seller invites a creator from the directory (vs. a creator joining). */
  invitedBySeller?: boolean;
}

/**
 * Join flow. Idempotent on (space, email): re-joining returns the existing
 * partner. Auto-approval follows the program setting; approved partners get
 * their first referral link immediately. Seller invites are always approved
 * (the seller chose them) and get an invite email instead of an approval one.
 */
export async function createPartner(
  input: CreatePartnerInput,
): Promise<{ partner: AffiliatePartnerRow; created: boolean } | null> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!email || !name) return null;

  const program = await getOrCreateDefaultProgram(input.spaceId);

  const { data: existing } = await supabase
    .from('AffiliatePartner')
    .select('*')
    .eq('spaceId', input.spaceId)
    .ilike('email', email)
    .maybeSingle();
  if (existing) return { partner: existing as AffiliatePartnerRow, created: false };

  const status: PartnerStatus =
    input.invitedBySeller || program.autoApproveAffiliates ? 'approved' : 'pending';
  const { data: partner, error } = await supabase
    .from('AffiliatePartner')
    .insert({
      spaceId: input.spaceId,
      programId: program.id,
      name,
      email,
      clerkUserId: input.clerkUserId ?? null,
      status,
      invitedBySeller: Boolean(input.invitedBySeller),
    })
    .select('*')
    .single();

  if (error || !partner) {
    logger.warn('[affiliates] createPartner failed', { error: error?.message });
    return null;
  }

  if (status === 'approved') {
    await createLink(partner.id);
    if (input.invitedBySeller) {
      const { data: space } = await supabase
        .from('Space')
        .select('name')
        .eq('id', input.spaceId)
        .maybeSingle();
      void sendPartnerInvitedEmail({
        to: email,
        partnerName: name,
        sellerName: space?.name ?? 'A software company',
      });
    } else {
      void sendPartnerApprovedEmail({ to: email, partnerName: name });
    }
  }

  return { partner: partner as AffiliatePartnerRow, created: true };
}

export async function approvePartner(partnerId: string): Promise<AffiliatePartnerRow | null> {
  const { data, error } = await supabase
    .from('AffiliatePartner')
    .update({ status: 'approved' })
    .eq('id', partnerId)
    .select('*')
    .single();
  if (error || !data) return null;

  const partner = data as AffiliatePartnerRow;
  // First approval for a partner with no links yet → give them one.
  const { count } = await supabase
    .from('ReferralLink')
    .select('id', { count: 'exact', head: true })
    .eq('partnerId', partnerId);
  if (!count) await createLink(partnerId);

  void sendPartnerApprovedEmail({ to: partner.email, partnerName: partner.name });
  return partner;
}

export async function suspendPartner(partnerId: string): Promise<AffiliatePartnerRow | null> {
  const { data, error } = await supabase
    .from('AffiliatePartner')
    .update({ status: 'suspended' })
    .eq('id', partnerId)
    .select('*')
    .single();
  if (error) return null;
  return data as AffiliatePartnerRow;
}

export async function getPartnerById(partnerId: string): Promise<AffiliatePartnerRow | null> {
  const { data } = await supabase
    .from('AffiliatePartner')
    .select('*')
    .eq('id', partnerId)
    .maybeSingle();
  return (data as AffiliatePartnerRow) ?? null;
}

/**
 * Resolve the partner for a signed-in user — by Clerk user id first, falling
 * back to email (and back-filling clerkUserId on first match so future
 * lookups are direct).
 */
export async function getPartnerByUser(opts: {
  clerkUserId?: string | null;
  email?: string | null;
}): Promise<AffiliatePartnerRow | null> {
  if (opts.clerkUserId) {
    const { data } = await supabase
      .from('AffiliatePartner')
      .select('*')
      .eq('clerkUserId', opts.clerkUserId)
      .order('createdAt', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) return data as AffiliatePartnerRow;
  }

  if (opts.email) {
    const { data } = await supabase
      .from('AffiliatePartner')
      .select('*')
      .ilike('email', opts.email.trim().toLowerCase())
      .order('createdAt', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) {
      const partner = data as AffiliatePartnerRow;
      if (opts.clerkUserId && !partner.clerkUserId) {
        await supabase
          .from('AffiliatePartner')
          .update({ clerkUserId: opts.clerkUserId })
          .eq('id', partner.id);
        partner.clerkUserId = opts.clerkUserId;
      }
      return partner;
    }
  }

  return null;
}

export const getPartnerByClerkUserId = (clerkUserId: string) =>
  getPartnerByUser({ clerkUserId });
export const getPartnerByEmail = (email: string) => getPartnerByUser({ email });

/**
 * ALL of a creator's partner rows — one per seller program they've joined
 * (the explore flow joins many). Matched by clerkUserId OR email.
 */
export async function getPartnersByUser(opts: {
  clerkUserId?: string | null;
  email?: string | null;
}): Promise<AffiliatePartnerRow[]> {
  const seen = new Map<string, AffiliatePartnerRow>();

  if (opts.clerkUserId) {
    const { data } = await supabase
      .from('AffiliatePartner')
      .select('*')
      .eq('clerkUserId', opts.clerkUserId)
      .order('createdAt', { ascending: true });
    for (const row of (data ?? []) as AffiliatePartnerRow[]) seen.set(row.id, row);
  }

  if (opts.email) {
    const { data } = await supabase
      .from('AffiliatePartner')
      .select('*')
      .ilike('email', opts.email.trim().toLowerCase())
      .order('createdAt', { ascending: true });
    for (const row of (data ?? []) as AffiliatePartnerRow[]) {
      if (!seen.has(row.id)) seen.set(row.id, row);
    }
  }

  return [...seen.values()];
}

/** Partners for a space, decorated with click/customer/earnings rollups. */
export async function listPartners(spaceId: string): Promise<PartnerWithStats[]> {
  const { data: partners } = await supabase
    .from('AffiliatePartner')
    .select('id, name, email, status, createdAt')
    .eq('spaceId', spaceId)
    .order('createdAt', { ascending: false });
  if (!partners || partners.length === 0) return [];

  const ids = partners.map((p) => p.id);

  const [linksRes, referralsRes, commissionsRes] = await Promise.all([
    supabase.from('ReferralLink').select('id, partnerId').in('partnerId', ids),
    supabase.from('Referral').select('partnerId, status').in('partnerId', ids),
    supabase
      .from('AffiliateCommission')
      .select('partnerId, amountCents, status')
      .in('partnerId', ids),
  ]);

  const linkIds = (linksRes.data ?? []).map((l) => l.id);
  const linkOwner = new Map((linksRes.data ?? []).map((l) => [l.id, l.partnerId]));
  const clickCounts = new Map<string, number>();
  if (linkIds.length > 0) {
    const { data: clicks } = await supabase
      .from('ReferralClick')
      .select('linkId')
      .in('linkId', linkIds);
    for (const c of clicks ?? []) {
      const owner = linkOwner.get(c.linkId);
      if (owner) clickCounts.set(owner, (clickCounts.get(owner) ?? 0) + 1);
    }
  }

  const customerCounts = new Map<string, number>();
  for (const r of referralsRes.data ?? []) {
    if (r.status === 'customer') {
      customerCounts.set(r.partnerId, (customerCounts.get(r.partnerId) ?? 0) + 1);
    }
  }

  const earned = new Map<string, number>();
  for (const c of commissionsRes.data ?? []) {
    if (c.status === 'approved' || c.status === 'paid') {
      earned.set(c.partnerId, (earned.get(c.partnerId) ?? 0) + (c.amountCents ?? 0));
    }
  }

  return partners.map((p) => ({
    id: p.id,
    name: p.name,
    email: p.email,
    status: p.status as PartnerStatus,
    createdAt: p.createdAt,
    clicks: clickCounts.get(p.id) ?? 0,
    customers: customerCounts.get(p.id) ?? 0,
    earnedCents: earned.get(p.id) ?? 0,
  }));
}
