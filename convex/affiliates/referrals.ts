import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * Referral data access — the Convex replacement for the `.from('Referral')`
 * reads & writes in conversions, recurring, stats, partners, link-analytics,
 * digests.
 *
 * Invariant preserved: idx_referral_link_buyer UNIQUE(linkId, lower(buyerEmail))
 * — one referral per link+buyer. upsertForConversion reads by_link_buyer
 * (lower-cased) and patches the existing row (status->customer, orderId,
 * convertedAt) or inserts a fresh one — the race-free version of the old
 * select-then-update-or-insert.
 */

const referralStatusValidator = v.union(v.literal('lead'), v.literal('customer'));

type ReferralFields = {
  id: string;
  linkId: string;
  partnerId: string;
  buyerEmail: string;
  orderId?: string;
  status: 'lead' | 'customer';
  firstClickAt?: string;
  convertedAt?: string;
  createdAt: string;
};

/**
 * The conversion upsert (recordConversion's Referral half). Read by_link_buyer
 * (lower-cased buyerEmail); if a row exists, mark it customer + attach the order
 * + stamp convertedAt; else insert a new customer referral with firstClickAt set
 * to the link's earliest click (passed in by the lib, which reads clicks) or
 * convertedAt. Returns the referral id either way. ONE serializable mutation.
 */
export const upsertForConversion = mutation({
  args: {
    linkId: v.string(),
    partnerId: v.string(),
    buyerEmail: v.string(),
    orderId: v.string(),
    /** Earliest click time for this link, or null (lib resolved from clicks). */
    firstClickAt: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<string> => {
    const buyerEmail = args.buyerEmail.trim().toLowerCase();
    const convertedAt = new Date().toISOString();

    const existing = await ctx.db
      .query('Referral')
      .withIndex('by_link_buyer', (q) => q.eq('linkId', args.linkId).eq('buyerEmail', buyerEmail))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: 'customer',
        orderId: args.orderId,
        convertedAt,
      });
      return existing.id;
    }

    const id = crypto.randomUUID();
    await ctx.db.insert('Referral', {
      id,
      linkId: args.linkId,
      partnerId: args.partnerId,
      buyerEmail,
      orderId: args.orderId,
      status: 'customer',
      firstClickAt: args.firstClickAt ?? convertedAt,
      convertedAt,
      createdAt: convertedAt,
    });
    return id;
  },
});

/**
 * The recurring-payment referral resolution (resolveReferral's code path). Find
 * the latest referral for a link — optionally constrained to a buyer email —
 * and create one (customer) if none exists and an email is known. Returns the
 * referral id, or null. Mirrors the lib's
 * `.eq('linkId').[ilike(email)].order(createdAt desc).limit(1)` then insert.
 */
export const resolveOrCreateForLink = mutation({
  args: {
    linkId: v.string(),
    partnerId: v.string(),
    email: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<string | null> => {
    const email = args.email ? args.email.trim().toLowerCase() : null;

    if (email) {
      // Constrained to (linkId, buyerEmail) — UNIQUE, so at most one.
      const existing = await ctx.db
        .query('Referral')
        .withIndex('by_link_buyer', (q) => q.eq('linkId', args.linkId).eq('buyerEmail', email))
        .unique();
      if (existing) return existing.id;
      // First payment for this link+buyer — create the referral.
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await ctx.db.insert('Referral', {
        id,
        linkId: args.linkId,
        partnerId: args.partnerId,
        buyerEmail: email,
        status: 'customer',
        firstClickAt: now,
        convertedAt: now,
        createdAt: now,
      });
      return id;
    }

    // No email: latest referral for the link, by createdAt desc.
    const rows = await ctx.db
      .query('Referral')
      .withIndex('by_link', (q) => q.eq('linkId', args.linkId))
      .collect();
    if (rows.length === 0) return null;
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows[0].id;
  },
});

/**
 * Email-match resolution within a space (resolveReferral's fallback): the most-
 * recently-converted referral among a set of partner ids whose buyerEmail matches.
 * Returns { referralId, partnerId } or null. Mirrors
 * `.in('partnerId', ids).ilike('buyerEmail', email).order('convertedAt' desc).limit(1)`.
 */
export const latestConvertedForPartnersByEmail = query({
  args: { partnerIds: v.array(v.string()), email: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const idSet = new Set(args.partnerIds);
    if (idSet.size === 0) return null;
    const matches: ReferralFields[] = [];
    for (const partnerId of idSet) {
      const rows = await ctx.db
        .query('Referral')
        .withIndex('by_partner', (q) => q.eq('partnerId', partnerId))
        .collect();
      for (const r of rows) if (r.buyerEmail === email) matches.push(r);
    }
    if (matches.length === 0) return null;
    // convertedAt DESC, nulls last (PG nullsFirst:false).
    matches.sort((a, b) => {
      const av = a.convertedAt ?? '';
      const bv = b.convertedAt ?? '';
      return av < bv ? 1 : av > bv ? -1 : 0;
    });
    return { referralId: matches[0].id, partnerId: matches[0].partnerId };
  },
});

/** (status) for a set of partner ids — stats' referral read (counts referrals +
 *  customers). Mirrors `.from('Referral').select('status').in('partnerId', ids)`. */
export const statusesForPartners = query({
  args: { partnerIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<Array<{ status: 'lead' | 'customer' }>> => {
    const out: Array<{ status: 'lead' | 'customer' }> = [];
    for (const partnerId of args.partnerIds) {
      const rows = await ctx.db
        .query('Referral')
        .withIndex('by_partner', (q) => q.eq('partnerId', partnerId))
        .collect();
      for (const r of rows) out.push({ status: r.status });
    }
    return out;
  },
});

/** (partnerId, status) for a set of partner ids — listPartners' customer rollup.
 *  Mirrors `.select('partnerId, status').in('partnerId', ids)`. */
export const partnerStatusPairsForPartners = query({
  args: { partnerIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Array<{ partnerId: string; status: 'lead' | 'customer' }> = [];
    for (const partnerId of args.partnerIds) {
      const rows = await ctx.db
        .query('Referral')
        .withIndex('by_partner', (q) => q.eq('partnerId', partnerId))
        .collect();
      for (const r of rows) out.push({ partnerId: r.partnerId, status: r.status });
    }
    return out;
  },
});

/** Count of CUSTOMER referrals across partner ids (getProgramStats / digest).
 *  Optional `since` filters by convertedAt (digest window). Mirrors the count
 *  `.in('partnerId', ids).eq('status','customer')[.gte('convertedAt', since)]`. */
export const customerCountForPartners = query({
  args: { partnerIds: v.array(v.string()), since: v.optional(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    let count = 0;
    for (const partnerId of args.partnerIds) {
      const rows = await ctx.db
        .query('Referral')
        .withIndex('by_partner', (q) => q.eq('partnerId', partnerId))
        .collect();
      for (const r of rows) {
        if (r.status !== 'customer') continue;
        if (args.since !== undefined && !(r.convertedAt != null && r.convertedAt >= args.since))
          continue;
        count += 1;
      }
    }
    return count;
  },
});

/** (id, linkId, status) for a set of link ids — link-analytics' referral read
 *  (it joins commissions back to links via referralId). Mirrors
 *  `.from('Referral').select('id, linkId, status').in('linkId', linkIds)`. */
export const byLinkIds = query({
  args: { linkIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Array<{ id: string; linkId: string; status: 'lead' | 'customer' }> = [];
    for (const linkId of args.linkIds) {
      const rows = await ctx.db
        .query('Referral')
        .withIndex('by_link', (q) => q.eq('linkId', linkId))
        .collect();
      for (const r of rows) out.push({ id: r.id, linkId: r.linkId, status: r.status });
    }
    return out;
  },
});

/** Distinct space ids with referral activity — not needed by current call sites;
 *  referrals carry no spaceId. (Intentionally omitted.) */

export { referralStatusValidator };
export type { ReferralFields };
