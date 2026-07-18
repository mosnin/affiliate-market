import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ReferralLink data access — the Convex replacement for the `.from('ReferralLink')`
 * reads & writes in lib/affiliates/links.ts.
 *
 * Pure logic stays in lib: code generation (generateReferralCode), vanity-code
 * normalization (normalizeVanityCode), URL building, discount clamping. Product
 * NAMES come from Convex marketplace.products (a separate module) and the click
 * counts for listLinksForPartner are joined in lib — this module returns the raw
 * ReferralLink rows the lib decorates.
 *
 * Uniqueness preserved: `code` is globally UNIQUE. createLink generates a code in
 * lib and passes candidates; this mutation re-checks by_code before insert (the
 * race-free check the PG unique index used to provide) and reports a collision so
 * the lib can retry with a fresh code — matching the old "insert, retry on
 * duplicate" loop, now collision-safe inside one serializable mutation.
 */

type LinkFields = {
  id: string;
  partnerId: string;
  programId: string;
  code: string;
  destinationUrl?: string;
  createdAt: string;
  productId?: string;
  discountPercent: number;
  isVanity: boolean;
};

/** ReferralLinkRow shape (lib/affiliates/links.ts#ReferralLinkRow). Surface `id`,
 *  coerce absent optionals -> null. */
function toLinkRow(l: LinkFields) {
  return {
    id: l.id,
    partnerId: l.partnerId,
    programId: l.programId,
    code: l.code,
    destinationUrl: l.destinationUrl ?? null,
    productId: l.productId ?? null,
    discountPercent: l.discountPercent ?? 0,
    isVanity: Boolean(l.isVanity),
    createdAt: l.createdAt,
  };
}

/** One link by code, or null. The attribution hot path (getLinkByCode). code is
 *  globally UNIQUE so .unique() is exact. Mirrors `.eq('code').maybeSingle()`. */
export const getByCode = query({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    if (!args.code) return null;
    const l = await ctx.db
      .query('ReferralLink')
      .withIndex('by_code', (q) => q.eq('code', args.code))
      .unique();
    return l ? toLinkRow(l) : null;
  },
});

/** The partner's (id, programId) — what createLink/createVanityLink read before
 *  minting a link. Mirrors `.from('AffiliatePartner').select('id, programId').eq('id')`.
 *  Lives here so the link-creation lib needs only one Convex module for the flow. */
export const partnerLinkContext = query({
  args: { partnerId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.partnerId))
      .unique();
    if (!p) return null;
    return { id: p.id, programId: p.programId };
  },
});

/**
 * Create an auto-generated referral link for a partner. The lib generates the
 * `code` (unambiguous 8-char alphabet) and passes it; this mutation looks up the
 * partner for programId and inserts, re-checking by_code first.
 *
 * Returns { link } on success, { collision: true } when the code is taken (lib
 * retries with a fresh code, mirroring the old duplicate-retry loop), or
 * { partnerMissing: true } when the partner is gone.
 */
export const create = mutation({
  args: {
    partnerId: v.string(),
    code: v.string(),
    destinationUrl: v.union(v.string(), v.null()),
    productId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const partner = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.partnerId))
      .unique();
    if (!partner) return { partnerMissing: true as const };

    const existing = await ctx.db
      .query('ReferralLink')
      .withIndex('by_code', (q) => q.eq('code', args.code))
      .unique();
    if (existing) return { collision: true as const };

    const doc = {
      id: crypto.randomUUID(),
      partnerId: partner.id,
      programId: partner.programId,
      code: args.code,
      ...(args.destinationUrl !== null ? { destinationUrl: args.destinationUrl } : {}),
      ...(args.productId !== null ? { productId: args.productId } : {}),
      discountPercent: 0,
      isVanity: false,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('ReferralLink', doc);
    return { link: toLinkRow(doc) };
  },
});

/**
 * Create a vanity link (human-chosen code, optional discount). The lib already
 * normalized the code and clamped discountPercent (0-90); this stores it,
 * re-checking by_code. Returns { collision: true } when taken (lib surfaces
 * "that code is taken"), { partnerMissing: true } when the partner is gone.
 */
export const createVanity = mutation({
  args: {
    partnerId: v.string(),
    code: v.string(),
    discountPercent: v.number(),
    productId: v.union(v.string(), v.null()),
    destinationUrl: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const partner = await ctx.db
      .query('AffiliatePartner')
      .withIndex('by_app_id', (q) => q.eq('id', args.partnerId))
      .unique();
    if (!partner) return { partnerMissing: true as const };

    const existing = await ctx.db
      .query('ReferralLink')
      .withIndex('by_code', (q) => q.eq('code', args.code))
      .unique();
    if (existing) return { collision: true as const };

    const doc = {
      id: crypto.randomUUID(),
      partnerId: partner.id,
      programId: partner.programId,
      code: args.code,
      discountPercent: args.discountPercent,
      isVanity: true,
      ...(args.productId !== null ? { productId: args.productId } : {}),
      ...(args.destinationUrl !== null ? { destinationUrl: args.destinationUrl } : {}),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('ReferralLink', doc);
    return { link: toLinkRow(doc) };
  },
});

/** Existing product link for a partner (earliest), or null. Mirrors
 *  `.eq('partnerId').eq('productId').order('createdAt' asc).limit(1).maybeSingle()`. */
export const getForProduct = query({
  args: { partnerId: v.string(), productId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ReferralLink')
      .withIndex('by_partner_product', (q) =>
        q.eq('partnerId', args.partnerId).eq('productId', args.productId),
      )
      .collect();
    if (rows.length === 0) return null;
    rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return toLinkRow(rows[0]);
  },
});

/** Raw link rows across a creator's partner ids, earliest-first. The lib joins
 *  click counts (ReferralClick) + product names (Convex Product) on top — this
 *  returns the columns listLinksForPartners reads:
 *  (id, code, destinationUrl, productId, discountPercent, isVanity). */
export const listForPartners = query({
  args: { partnerIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const all: LinkFields[] = [];
    for (const partnerId of args.partnerIds) {
      const rows = await ctx.db
        .query('ReferralLink')
        .withIndex('by_partner', (q) => q.eq('partnerId', partnerId))
        .collect();
      all.push(...rows);
    }
    all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return all.map((l) => ({
      id: l.id,
      code: l.code,
      destinationUrl: l.destinationUrl ?? null,
      productId: l.productId ?? null,
      discountPercent: l.discountPercent ?? 0,
      isVanity: Boolean(l.isVanity),
    }));
  },
});

/** All link ids for a set of partner ids — what stats/link-analytics start from
 *  before counting clicks. Mirrors `.from('ReferralLink').select('id').in('partnerId', ids)`. */
export const idsForPartners = query({
  args: { partnerIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<string[]> => {
    const ids: string[] = [];
    for (const partnerId of args.partnerIds) {
      const rows = await ctx.db
        .query('ReferralLink')
        .withIndex('by_partner', (q) => q.eq('partnerId', partnerId))
        .collect();
      for (const l of rows) ids.push(l.id);
    }
    return ids;
  },
});

/** Count of links for one partner (the approvePartner "has any link yet?" gate).
 *  Mirrors `.from('ReferralLink').select('id', { count, head }).eq('partnerId')`. */
export const countForPartner = query({
  args: { partnerId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('ReferralLink')
      .withIndex('by_partner', (q) => q.eq('partnerId', args.partnerId))
      .collect();
    return rows.length;
  },
});

export type { LinkFields };
