import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ReferralClick data access — the Convex replacement for the
 * `.from('ReferralClick')` reads & writes in tracking, conversions, stats,
 * partners, link-analytics, digests.
 *
 * Append-only telemetry. The lib resolves the link from the code first
 * (getLinkByCode is its own Convex module), then calls record with the link id.
 */

/**
 * Log a click for a link. recordClick's DB hop. The lib already resolved the
 * link id from the code and truncated the long fields (userAgent 512,
 * landingUrl/referrer 2048). Null fields are stored absent (SQL NULL). Returns
 * the new click id.
 */
export const record = mutation({
  args: {
    linkId: v.string(),
    visitorId: v.union(v.string(), v.null()),
    ipHash: v.union(v.string(), v.null()),
    userAgent: v.union(v.string(), v.null()),
    landingUrl: v.union(v.string(), v.null()),
    referrer: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<string> => {
    const id = crypto.randomUUID();
    await ctx.db.insert('ReferralClick', {
      id,
      linkId: args.linkId,
      ...(args.visitorId !== null ? { visitorId: args.visitorId } : {}),
      ...(args.ipHash !== null ? { ipHash: args.ipHash } : {}),
      ...(args.userAgent !== null ? { userAgent: args.userAgent } : {}),
      ...(args.landingUrl !== null ? { landingUrl: args.landingUrl } : {}),
      ...(args.referrer !== null ? { referrer: args.referrer } : {}),
      createdAt: new Date().toISOString(),
    });
    return id;
  },
});

/** createdAt of the LATEST click for a link, or null — the attribution-window
 *  check in recordConversion. Mirrors `.eq('linkId').order('createdAt' desc)
 *  .limit(1).maybeSingle()` projected to createdAt. by_link_created is desc-ready. */
export const lastClickAtForLink = query({
  args: { linkId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const latest = await ctx.db
      .query('ReferralClick')
      .withIndex('by_link_created', (q) => q.eq('linkId', args.linkId))
      .order('desc')
      .first();
    return latest?.createdAt ?? null;
  },
});

/** createdAt of the EARLIEST click for a link, or null — firstClickAt seed when
 *  a conversion creates a new referral. Mirrors `.order('createdAt' asc).limit(1)`. */
export const firstClickAtForLink = query({
  args: { linkId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const earliest = await ctx.db
      .query('ReferralClick')
      .withIndex('by_link_created', (q) => q.eq('linkId', args.linkId))
      .order('asc')
      .first();
    return earliest?.createdAt ?? null;
  },
});

/** Click counts per link id (stats/partners/link-analytics). Optional `since`
 *  filters by createdAt (digest window). Returns [{ linkId, count }] for every
 *  link id passed (zero when none). Mirrors the per-link click tallies the lib
 *  built from `.select('linkId').in('linkId', linkIds)`. */
export const countsByLink = query({
  args: { linkIds: v.array(v.string()), since: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const out: Array<{ linkId: string; count: number }> = [];
    for (const linkId of args.linkIds) {
      const rows = await ctx.db
        .query('ReferralClick')
        .withIndex('by_link_created', (q) => q.eq('linkId', linkId))
        .collect();
      const count =
        args.since === undefined
          ? rows.length
          : rows.filter((c) => c.createdAt >= args.since!).length;
      out.push({ linkId, count });
    }
    return out;
  },
});

/** Total click count across a set of link ids (the head-count stats path).
 *  Optional `since`. Mirrors `.select('id', { count, head }).in('linkId', ids)
 *  [.gte('createdAt', since)]`. */
export const totalCountForLinks = query({
  args: { linkIds: v.array(v.string()), since: v.optional(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    let total = 0;
    for (const linkId of args.linkIds) {
      const rows = await ctx.db
        .query('ReferralClick')
        .withIndex('by_link_created', (q) => q.eq('linkId', linkId))
        .collect();
      total += args.since === undefined ? rows.length : rows.filter((c) => c.createdAt >= args.since!).length;
    }
    return total;
  },
});
