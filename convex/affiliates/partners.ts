import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * AffiliatePartner data access — the Convex replacement for the
 * `.from('AffiliatePartner')` reads & writes across lib/affiliates
 * (partners, conversions, recurring, tier2, payouts, reversals, creators).
 *
 * CROSS-DOMAIN STAYS IN LIB (CONVENTIONS): createPartner orchestrates
 * getOrCreateDefaultProgram + createLink + approval/invite emails + the
 * owner-notify email. Those stay lib calls. This module provides only the
 * AffiliatePartner table hops; createIdempotent does the (space,email) upsert,
 * and the lib calls createLink (its own Convex module) afterwards.
 *
 * Invariant preserved: idx_affiliate_partner_space_email UNIQUE(spaceId,
 * lower(email)) — one partner per (space, email). createIdempotent reads
 * by_space_email (lower-cased email) before insert, returning the existing row
 * when present (created:false) — the race-free version of the old
 * select-then-insert.
 *
 * Clawbacks: balanceAdjustmentCents goes NEGATIVE when a paid commission is
 * reversed; adjustBalance/setBalance carry that. Never recomputed — the lib
 * passes the delta/value.
 */

const partnerStatusValidator = v.union(
  v.literal('pending'),
  v.literal('approved'),
  v.literal('suspended'),
);

type PartnerFields = {
  id: string;
  spaceId: string;
  programId: string;
  name: string;
  email: string;
  clerkUserId?: string;
  status: 'pending' | 'approved' | 'suspended';
  payoutMethod?: string;
  payoutDetails?: unknown;
  createdAt: string;
  stripeAccountId?: string;
  balanceAdjustmentCents: number;
  invitedBySeller: boolean;
  parentPartnerId?: string;
};

/** AffiliatePartnerRow shape (lib/affiliates/partners.ts#AffiliatePartnerRow).
 *  Surface `id`, coerce absent optionals -> null. invitedBySeller is internal-
 *  only on the lib Row but harmless to include; we mirror the documented Row. */
function toPartnerRow(p: PartnerFields) {
  return {
    id: p.id,
    spaceId: p.spaceId,
    programId: p.programId,
    name: p.name,
    email: p.email,
    clerkUserId: p.clerkUserId ?? null,
    status: p.status,
    payoutMethod: p.payoutMethod ?? null,
    payoutDetails: (p.payoutDetails ?? null) as Record<string, unknown> | null,
    stripeAccountId: p.stripeAccountId ?? null,
    parentPartnerId: p.parentPartnerId ?? null,
    createdAt: p.createdAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One partner by id, or null. Mirrors getPartnerById. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return p ? toPartnerRow(p) : null;
  },
});

/** The single partner for a (space, lower(email)), or null — the createPartner
 *  pre-check and the join-flow idempotency read. Mirrors
 *  `.eq('spaceId').ilike('email', email).maybeSingle()` (lib lowercases first). */
export const getBySpaceEmail = query({
  args: { spaceId: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_space_email', (q) =>
        q.eq('spaceId', args.spaceId).eq('email', args.email.trim().toLowerCase()),
      )
      .unique();
    return p ? toPartnerRow(p) : null;
  },
});

/**
 * Resolve a partner by clerk id first, then by lower(email), earliest-created.
 * getPartnerByUser's read half. Returns the row (or null). The lib does the
 * clerkUserId BACK-FILL via backfillClerkId below (one extra mutation) so this
 * stays a pure query.
 */
export const getByUser = query({
  args: {
    clerkUserId: v.union(v.string(), v.null()),
    email: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    if (args.clerkUserId) {
      const rows = await ctx.db
        .query('AffiliatePartner')
        .withIndex('by_clerk', (q) => q.eq('clerkUserId', args.clerkUserId!))
        .collect();
      if (rows.length > 0) {
        rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
        return toPartnerRow(rows[0]);
      }
    }
    if (args.email) {
      const email = args.email.trim().toLowerCase();
      const rows = await ctx.db
        .query('AffiliatePartner')
        .withIndex('by_email', (q) => q.eq('email', email))
        .collect();
      if (rows.length > 0) {
        rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
        return toPartnerRow(rows[0]);
      }
    }
    return null;
  },
});

/** ALL of a creator's partner rows — clerk id OR email, deduped by id,
 *  earliest-first. getPartnersByUser. */
export const listByUser = query({
  args: {
    clerkUserId: v.union(v.string(), v.null()),
    email: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const seen = new Map<string, PartnerFields>();
    if (args.clerkUserId) {
      const rows = await ctx.db
        .query('AffiliatePartner')
        .withIndex('by_clerk', (q) => q.eq('clerkUserId', args.clerkUserId!))
        .collect();
      for (const r of rows) seen.set(r.id, r);
    }
    if (args.email) {
      const email = args.email.trim().toLowerCase();
      const rows = await ctx.db
        .query('AffiliatePartner')
        .withIndex('by_email', (q) => q.eq('email', email))
        .collect();
      for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
    }
    const list = [...seen.values()];
    list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return list.map(toPartnerRow);
  },
});

/** Raw partner rows for a space, newest-first — the base listPartners reads
 *  (id, name, email, status, createdAt). The lib joins clicks/customers/earnings. */
export const listForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      status: p.status,
      createdAt: p.createdAt,
    }));
  },
});

/** (id, status) for a space's partners — getProgramStats' partner read. */
export const statusesForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.map((p) => ({ id: p.id, status: p.status }));
  },
});

/** Approved partner ids for a space — resolveReferral's email-match candidate set.
 *  Mirrors `.eq('spaceId').eq('status','approved')` projected to ids. */
export const approvedPartnerIdsForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const rows = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', 'approved'))
      .collect();
    return rows.map((p) => p.id);
  },
});

/** Count of a space's partners created since `since` (digest "new partners").
 *  Mirrors `.eq('spaceId').gte('createdAt', since)` count. */
export const countForSpaceSince = query({
  args: { spaceId: v.string(), since: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.filter((p) => p.createdAt >= args.since).length;
  },
});

/** Count of a space's pending partners (digest). Mirrors `.eq('spaceId').eq('status','pending')`. */
export const countPendingForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', 'pending'))
      .collect();
    return rows.length;
  },
});

/** Distinct space ids with a partner created since `since` (digest active-spaces).
 *  Mirrors `.from('AffiliatePartner').select('spaceId').gte('createdAt', since)`. */
export const spaceIdsWithPartnerSince = query({
  args: { since: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const rows = await ctx.db.query('AffiliatePartner').collect();
    const ids = new Set<string>();
    for (const p of rows) if (p.createdAt >= args.since) ids.add(p.spaceId);
    return [...ids];
  },
});

/** name + email for a partner (the payout-completed / commission emails read it).
 *  Mirrors `.select('name, email').eq('id').maybeSingle()`. */
export const nameEmailById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p) return null;
    return { name: p.name, email: p.email };
  },
});

/** Payout context for createPayout: (payoutMethod, stripeAccountId,
 *  balanceAdjustmentCents, programId). Mirrors the `.select(...).eq('id')` there. */
export const payoutContext = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p) return null;
    return {
      payoutMethod: p.payoutMethod ?? null,
      stripeAccountId: p.stripeAccountId ?? null,
      balanceAdjustmentCents: p.balanceAdjustmentCents ?? 0,
      programId: p.programId,
    };
  },
});

/** Sum of balanceAdjustmentCents across a creator's partner rows (getPayable-
 *  BalanceCentsForPartners). Mirrors `.select('balanceAdjustmentCents').in('id', ids)`. */
export const balanceAdjustmentForPartners = query({
  args: { partnerIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    let sum = 0;
    for (const id of args.partnerIds) {
      const p = await ctx.db
        .query('AffiliatePartner')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (p) sum += p.balanceAdjustmentCents ?? 0;
    }
    return sum;
  },
});

/** Tier-2 lookup for a child partner: (parentPartnerId, programId, email).
 *  Mirrors the child `.select('parentPartnerId, programId, email').eq('id')`. */
export const tier2ChildContext = query({
  args: { childPartnerId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.childPartnerId))
      .unique();
    if (!p) return null;
    return {
      parentPartnerId: p.parentPartnerId ?? null,
      programId: p.programId,
      email: p.email ?? null,
    };
  },
});

/** Parent partner (id, name, email, status) for the tier-2 override.
 *  Mirrors `.select('id, name, email, status').eq('id')`. */
export const tier2ParentContext = query({
  args: { parentPartnerId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.parentPartnerId))
      .unique();
    if (!p) return null;
    return { id: p.id, name: p.name, email: p.email, status: p.status };
  },
});

/** (id, name, email, stripeAccountId) for many partners — tax-export's partner
 *  decoration. Mirrors `.select('id, name, email, stripeAccountId').in('id', ids)`. */
export const taxInfoForPartners = query({
  args: { partnerIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Array<{
      id: string;
      name: string;
      email: string;
      stripeAccountId: string | null;
    }> = [];
    for (const id of args.partnerIds) {
      const p = await ctx.db
        .query('AffiliatePartner')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (p)
        out.push({
          id: p.id,
          name: p.name,
          email: p.email,
          stripeAccountId: p.stripeAccountId ?? null,
        });
    }
    return out;
  },
});

/** Negative balanceAdjustmentCents across all partners (finance clawback total).
 *  Mirrors `.from('AffiliatePartner').select('balanceAdjustmentCents')`. */
export const allBalanceAdjustments = query({
  args: {},
  handler: async (ctx): Promise<number[]> => {
    const rows = await ctx.db.query('AffiliatePartner').collect();
    return rows.map((p) => p.balanceAdjustmentCents ?? 0);
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * The (space,email)-idempotent join insert. createPartner's DB hop: read
 * by_space_email (lower-cased), return the existing row if present
 * (created:false), else insert with the computed status. The lib already
 * resolved program.id + status (autoApprove/invitedBySeller) and lowercased the
 * email; it calls createLink + emails afterwards. Returns the row + created flag.
 */
export const createIdempotent = mutation({
  args: {
    spaceId: v.string(),
    programId: v.string(),
    name: v.string(),
    email: v.string(),
    clerkUserId: v.union(v.string(), v.null()),
    status: partnerStatusValidator,
    invitedBySeller: v.boolean(),
    parentPartnerId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const existing = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_space_email', (q) => q.eq('spaceId', args.spaceId).eq('email', email))
      .unique();
    if (existing) return { partner: toPartnerRow(existing), created: false };

    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      programId: args.programId,
      name: args.name.trim(),
      email,
      ...(args.clerkUserId !== null ? { clerkUserId: args.clerkUserId } : {}),
      status: args.status,
      balanceAdjustmentCents: 0,
      invitedBySeller: args.invitedBySeller,
      ...(args.parentPartnerId !== null ? { parentPartnerId: args.parentPartnerId } : {}),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('AffiliatePartner', doc);
    return { partner: toPartnerRow(doc), created: true };
  },
});

/** Approve a partner (status -> 'approved'). Returns the updated row or null.
 *  The lib then ensures a link exists (countForPartner + createLink) and emails. */
export const approve = mutation({
  args: { partnerId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.partnerId))
      .unique();
    if (!p) return null;
    await ctx.db.patch(p._id, { status: 'approved' });
    const updated = (await ctx.db.get(p._id))!;
    return toPartnerRow(updated);
  },
});

/** Suspend a partner (status -> 'suspended'). Returns the updated row or null. */
export const suspend = mutation({
  args: { partnerId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.partnerId))
      .unique();
    if (!p) return null;
    await ctx.db.patch(p._id, { status: 'suspended' });
    const updated = (await ctx.db.get(p._id))!;
    return toPartnerRow(updated);
  },
});

/** Back-fill clerkUserId on a partner that matched by email only (getPartnerByUser
 *  side effect). No-op if the row vanished or already has one. */
export const backfillClerkId = mutation({
  args: { partnerId: v.string(), clerkUserId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.partnerId))
      .unique();
    if (!p || p.clerkUserId) return;
    await ctx.db.patch(p._id, { clerkUserId: args.clerkUserId });
  },
});

/** Set the partner's Stripe Connect account id (onboarding). No-op if absent. */
export const setStripeAccountId = mutation({
  args: { partnerId: v.string(), stripeAccountId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.partnerId))
      .unique();
    if (!p) return;
    await ctx.db.patch(p._id, { stripeAccountId: args.stripeAccountId });
  },
});

/**
 * Atomically add `deltaCents` to balanceAdjustmentCents (refund clawback makes
 * it go negative). Replaces the reversal's read-modify-write on the partner — now
 * a single serializable read+patch. The lib passes the delta (e.g. -netCents).
 */
export const adjustBalance = mutation({
  args: { partnerId: v.string(), deltaCents: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.partnerId))
      .unique();
    if (!p) return;
    await ctx.db.patch(p._id, {
      balanceAdjustmentCents: (p.balanceAdjustmentCents ?? 0) + args.deltaCents,
    });
  },
});

/** Set balanceAdjustmentCents to an absolute value (payout zeroes/carries the
 *  clawback debt). The lib computes the value (0, or adjustment+approvedNet). */
export const setBalanceAdjustment = mutation({
  args: { partnerId: v.string(), valueCents: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.partnerId))
      .unique();
    if (!p) return;
    await ctx.db.patch(p._id, { balanceAdjustmentCents: args.valueCents });
  },
});

export type { PartnerFields };
// Doc kept imported for parity with sibling modules that type stored rows.
export type PartnerDoc = Doc<'AffiliatePartner'>;
