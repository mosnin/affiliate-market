import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * Space data access — the Convex replacement for every `.from('Space')` read &
 * write across lib/ and the routes (lib/space.ts, billing, the Stripe webhook,
 * onboarding, manager/admin surfaces, AI tasks, marketplace fees/sellers, …).
 *
 * Space is the platform core: almost every other table FKs to Space.id, so the
 * row shape here must be exact. We expose `id` (the app's string PK, NOT Convex's
 * `_id`) and coerce absent optionals to SQL NULL so the legacy `Space` Row shape
 * (lib/types.ts) survives untouched.
 *
 * CROSS-DOMAIN STAYS IN LIB (CONVENTIONS): getSpaceOwnerEmail / userOwnsSpace /
 * getSpaceForUser also hop to the User table (still on Supabase) and
 * CompanyMembership. Those orchestrations remain in lib — this module only
 * provides the Space-table half. getSpaceForUser/userOwnsSpace become "lib
 * resolves the User → userId, then calls spaces.getByOwnerId / ownsSpace here".
 */

type SpaceFields = {
  id: string;
  slug: string;
  name: string;
  emoji: string;
  createdAt: string;
  ownerId: string;
  companyId?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeSubscriptionStatus: string;
  stripePeriodEnd?: string;
  trialUsedAt?: string;
  stripeConnectAccountId?: string;
  marketplaceFeeBps?: number;
  plan: string;
  planActivatedAt?: string;
};

/**
 * The full legacy `Space` row (lib/types.ts#Space carries the first 11 columns;
 * the `*` select pages read the rest). Surfaces `id`, coerces absent optionals to
 * null. Every read returns this single shape; callers that selected a subset just
 * ignore the extra keys (PostgREST column projection was a wire optimization, not
 * a contract — the decorate fns only touch the columns they named).
 */
function toRow(s: SpaceFields) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    emoji: s.emoji,
    createdAt: s.createdAt,
    ownerId: s.ownerId,
    companyId: s.companyId ?? null,
    stripeCustomerId: s.stripeCustomerId ?? null,
    stripeSubscriptionId: s.stripeSubscriptionId ?? null,
    stripeSubscriptionStatus: s.stripeSubscriptionStatus,
    stripePeriodEnd: s.stripePeriodEnd ?? null,
    trialUsedAt: s.trialUsedAt ?? null,
    stripeConnectAccountId: s.stripeConnectAccountId ?? null,
    marketplaceFeeBps: s.marketplaceFeeBps ?? null,
    plan: s.plan,
    planActivatedAt: s.planActivatedAt ?? null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One space by its string id, or null. Mirrors `.eq('id', spaceId).maybeSingle()`
 *  (the dozens of id lookups: notify, billing, AI tasks, marketplace fees/sellers,
 *  cron, demos, cma, settings/tracking, s/[slug]/layout subscription gate). */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('Space')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return s ? toRow(s) : null;
  },
});

/** Several spaces by id-set, in arbitrary order. Mirrors `.in('id', spaceIds)`
 *  (marketplace orders/products decorate, admin moderation/affiliate-finance,
 *  client-portal, cron routines, admin support). */
export const listByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.ids.length === 0) return [];
    const wanted = new Set(args.ids);
    // Point-lookups on the id index — cheaper than a full scan for the small id
    // sets these decorate paths pass.
    const out: ReturnType<typeof toRow>[] = [];
    for (const id of wanted) {
      const s = await ctx.db
        .query('Space')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (s) out.push(toRow(s));
    }
    return out;
  },
});

/** One space by slug (the public workspace URL key), or null. Mirrors
 *  getSpaceFromSlug + every `.eq('slug', slug).maybeSingle()`. The lib lowercases/
 *  normalizes the slug before calling, matching the stored value. */
export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('Space')
      .withIndex('by_slug', (q) => q.eq('slug', args.slug))
      .first();
    return s ? toRow(s) : null;
  },
});

/** The single producing space for an owner (Space.ownerId is unique), or null.
 *  Mirrors getSpaceByOwnerId / getSpaceForUser's Space half / onboarding /
 *  manager layout / integrations callback `.eq('ownerId', x).maybeSingle()`. */
export const getByOwnerId = query({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('Space')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
      .first();
    return s ? toRow(s) : null;
  },
});

/** Spaces owned by any of `ownerIds`. Mirrors `.in('ownerId', userIds)` — the
 *  company-member fan-outs (company-members, manager stats/agent-activity/
 *  form-config push, admin/companies, manager members/leads export). */
export const listByOwnerIds = query({
  args: { ownerIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.ownerIds.length === 0) return [];
    const wanted = new Set(args.ownerIds);
    const out: ReturnType<typeof toRow>[] = [];
    for (const ownerId of wanted) {
      const s = await ctx.db
        .query('Space')
        .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
        .first();
      if (s) out.push(toRow(s));
    }
    return out;
  },
});

/** True when `clerk`-resolved userId owns the space. The lib resolves clerkId →
 *  User.id first (User stays on Supabase), then calls this. Mirrors userOwnsSpace's
 *  Space half: `.eq('id', spaceId).eq('ownerId', userId).maybeSingle()`. */
export const ownsSpace = query({
  args: { spaceId: v.string(), ownerId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const s = await ctx.db
      .query('Space')
      .withIndex('by_app_id', (q) => q.eq('id', args.spaceId))
      .unique();
    return !!s && s.ownerId === args.ownerId;
  },
});

/** Spaces in a company. Mirrors `.eq('companyId', companyId)` (manager activity)
 *  and the `.in('ownerId', userIds).eq('companyId', id)` company-routing / manager
 *  form-config push reads (caller passes the already-resolved ownerIds to scope). */
export const listByCompanyId = query({
  args: { companyId: v.string(), ownerIds: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Space')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .collect();
    if (args.ownerIds && args.ownerIds.length > 0) {
      const allow = new Set(args.ownerIds);
      return rows.filter((s) => allow.has(s.ownerId)).map(toRow);
    }
    return rows.map(toRow);
  },
});

/** One space by Stripe subscription id (the webhook legacy path when metadata
 *  spaceId is absent), or null. Mirrors `.eq('stripeSubscriptionId', id).maybeSingle()`. */
export const getByStripeSubscriptionId = query({
  args: { stripeSubscriptionId: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('Space')
      .withIndex('by_stripe_subscription', (q) =>
        q.eq('stripeSubscriptionId', args.stripeSubscriptionId),
      )
      .first();
    return s ? toRow(s) : null;
  },
});

/** Spaces with a given subscription status. Mirrors broadcast's
 *  `.eq('stripeSubscriptionStatus', status).limit(n)` and (status optional →
 *  full list) admin-metrics / cohorts / admin billing scans. No PG index on
 *  status existed; this is the scan those pages already did, returned typed. */
export const listBySubscriptionStatus = query({
  args: { status: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows: Doc<'Space'>[] = await ctx.db.query('Space').collect();
    let filtered =
      args.status === undefined
        ? rows
        : rows.filter((s) => s.stripeSubscriptionStatus === args.status);
    if (args.limit !== undefined) filtered = filtered.slice(0, args.limit);
    return filtered.map(toRow);
  },
});

/** Spaces whose subscription status is in `statuses`, ordered by id asc, paged.
 *  Mirrors agent-sweep's `.in('stripeSubscriptionStatus', ['active','trialing'])
 *  .order('id').range(from, from+size-1)`. */
export const listBySubscriptionStatusesPaged = query({
  args: { statuses: v.array(v.string()), from: v.number(), size: v.number() },
  handler: async (ctx, args) => {
    const allow = new Set(args.statuses);
    const rows = await ctx.db.query('Space').collect();
    const matched = rows
      .filter((s) => allow.has(s.stripeSubscriptionStatus))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return matched.slice(args.from, args.from + args.size).map(toRow);
  },
});

/** All spaces, newest-first, capped. Mirrors admin/spaces' `.order('createdAt',
 *  desc).limit(200)`. (admin pages also do trialing/past_due/createdAt-window
 *  scans with a User join — the join stays in lib; this returns the Space rows.) */
export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query('Space').collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.slice(0, args.limit ?? 200).map(toRow);
  },
});

/** Count of spaces with a given subscription status. Mirrors admin/broadcast's
 *  `.select('*', { count: 'exact', head: true }).eq('stripeSubscriptionStatus', x)`. */
export const countBySubscriptionStatus = query({
  args: { status: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db.query('Space').collect();
    return rows.filter((s) => s.stripeSubscriptionStatus === args.status).length;
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create a space. Mirrors onboarding's `.insert({ id, slug, name, emoji, ownerId })`.
 * `id` is app-supplied (the route mints it), NOT generated here — Space PKs are
 * not gen_random_uuid in PG either. emoji defaults to '🏠'; the un-set columns
 * take their PG defaults (stripeSubscriptionStatus 'inactive', plan 'free').
 *
 * Preserves the ownerId-unique invariant: the route already guards "does this
 * owner have a space?" via getByOwnerId; we re-check here inside the mutation so a
 * concurrent double-submit can't create two. Returns the created OR pre-existing
 * row (matching the route's race-handling that re-reads the owner's space).
 */
export const create = mutation({
  args: {
    id: v.string(),
    slug: v.string(),
    name: v.string(),
    emoji: v.optional(v.string()),
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    // ownerId is the unique "one producing space per user" key — re-check.
    const existingByOwner = await ctx.db
      .query('Space')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
      .first();
    if (existingByOwner) return { row: toRow(existingByOwner), created: false };

    const doc: SpaceFields = {
      id: args.id,
      slug: args.slug,
      name: args.name,
      emoji: args.emoji ?? '🏠',
      ownerId: args.ownerId,
      stripeSubscriptionStatus: 'inactive',
      plan: 'free',
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('Space', doc);
    return { row: toRow(doc), created: true };
  },
});

/** Slug-keyed profile/companyId update (the PATCH /api/spaces dynamic
 *  `updateFields`: name/emoji/slug/companyId). Mirrors `.update(fields).eq('slug',
 *  slug)`. Returns the updated row (the route's `.select(...)`), or null if gone. */
export const updateBySlug = mutation({
  args: {
    slug: v.string(),
    fields: v.object({
      name: v.optional(v.string()),
      emoji: v.optional(v.string()),
      slug: v.optional(v.string()),
      companyId: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('Space')
      .withIndex('by_slug', (q) => q.eq('slug', args.slug))
      .first();
    if (!s) return null;
    const patch: Record<string, unknown> = {};
    if (args.fields.name !== undefined) patch.name = args.fields.name;
    if (args.fields.emoji !== undefined) patch.emoji = args.fields.emoji;
    if (args.fields.slug !== undefined) patch.slug = args.fields.slug;
    if (args.fields.companyId !== undefined) patch.companyId = args.fields.companyId;
    if (Object.keys(patch).length > 0) await ctx.db.patch(s._id, patch);
    return toRow((await ctx.db.get(s._id))!);
  },
});

/**
 * Patch a space's Stripe/billing/plan columns by id. One mutation covers every
 * `.update({...}).eq('id', spaceId)` the webhook + admin actions do (checkout
 * completed, subscription updated, plan sync, comp-free-month). Tri-state: a
 * provided `null` clears the optional column; an absent key leaves it. No-op if
 * the space vanished.
 *
 * `stripeSubscriptionStatus` / `plan` are NOT NULL columns — passing null for
 * them is ignored (they can only be set to a string), matching the code which
 * never nulls them.
 */
export const patchBillingById = mutation({
  args: {
    id: v.string(),
    stripeCustomerId: v.optional(v.union(v.string(), v.null())),
    stripeSubscriptionId: v.optional(v.union(v.string(), v.null())),
    stripeSubscriptionStatus: v.optional(v.string()),
    stripePeriodEnd: v.optional(v.union(v.string(), v.null())),
    trialUsedAt: v.optional(v.union(v.string(), v.null())),
    plan: v.optional(v.string()),
    planActivatedAt: v.optional(v.union(v.string(), v.null())),
    companyId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<void> => {
    const s = await ctx.db
      .query('Space')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!s) return;
    const patch: Record<string, unknown> = {};
    const setTriState = (key: string, val: string | null | undefined) => {
      if (val === undefined) return;
      patch[key] = val === null ? undefined : val;
    };
    setTriState('stripeCustomerId', args.stripeCustomerId);
    setTriState('stripeSubscriptionId', args.stripeSubscriptionId);
    if (args.stripeSubscriptionStatus !== undefined)
      patch.stripeSubscriptionStatus = args.stripeSubscriptionStatus;
    setTriState('stripePeriodEnd', args.stripePeriodEnd);
    setTriState('trialUsedAt', args.trialUsedAt);
    if (args.plan !== undefined) patch.plan = args.plan;
    setTriState('planActivatedAt', args.planActivatedAt);
    setTriState('companyId', args.companyId);
    if (Object.keys(patch).length > 0) await ctx.db.patch(s._id, patch);
  },
});

/**
 * Patch the billing columns of every space matching a Stripe subscription id (the
 * webhook legacy path: subscription.updated/deleted, invoice.payment_succeeded/
 * failed, when the metadata spaceId is absent). Mirrors `.update({...})
 * .eq('stripeSubscriptionId', id)[.eq('stripeCustomerId', cust)]`. The optional
 * `stripeCustomerId` arg tightens the match exactly as the extra `.eq` did.
 */
export const patchBillingBySubscriptionId = mutation({
  args: {
    stripeSubscriptionId: v.string(),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionStatus: v.optional(v.string()),
    stripePeriodEnd: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Space')
      .withIndex('by_stripe_subscription', (q) =>
        q.eq('stripeSubscriptionId', args.stripeSubscriptionId),
      )
      .collect();
    const targets =
      args.stripeCustomerId === undefined
        ? rows
        : rows.filter((s) => s.stripeCustomerId === args.stripeCustomerId);
    const patch: Record<string, unknown> = {};
    if (args.stripeSubscriptionStatus !== undefined)
      patch.stripeSubscriptionStatus = args.stripeSubscriptionStatus;
    if (args.stripePeriodEnd !== undefined)
      patch.stripePeriodEnd = args.stripePeriodEnd === null ? undefined : args.stripePeriodEnd;
    for (const s of targets) {
      if (Object.keys(patch).length > 0) await ctx.db.patch(s._id, patch);
    }
    return targets.length;
  },
});

/** Set the space's Stripe Connect account id by id. Mirrors marketplace/sellers'
 *  `.update({ stripeConnectAccountId }).eq('id', spaceId)`. */
export const setConnectAccountId = mutation({
  args: { id: v.string(), stripeConnectAccountId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const s = await ctx.db
      .query('Space')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!s) return;
    await ctx.db.patch(s._id, { stripeConnectAccountId: args.stripeConnectAccountId });
  },
});

/**
 * Claim a space's Stripe customer id only if it's currently unset. Mirrors
 * billing/checkout's race-safe `.update({ stripeCustomerId }).eq('id', spaceId)
 * .is('stripeCustomerId', null).select('stripeCustomerId').single()` — the
 * conditional write that lets concurrent checkouts converge on one customer.
 * Returns the winning customer id (ours if we claimed, else the existing one),
 * or null if the space vanished.
 */
export const claimStripeCustomerId = mutation({
  args: { id: v.string(), stripeCustomerId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const s = await ctx.db
      .query('Space')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!s) return null;
    if (s.stripeCustomerId == null) {
      await ctx.db.patch(s._id, { stripeCustomerId: args.stripeCustomerId });
      return args.stripeCustomerId;
    }
    return s.stripeCustomerId;
  },
});

/** Null out companyId for every space in a company (admin company delete) or for
 *  one space by id (admin membership delete / manager). Mirrors
 *  `.update({ companyId: null }).eq('companyId', id)` and `.eq('id', id)`. */
export const unlinkCompany = mutation({
  args: { companyId: v.optional(v.string()), spaceId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    let targets: Doc<'Space'>[] = [];
    if (args.companyId !== undefined) {
      targets = await ctx.db
        .query('Space')
        .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
        .collect();
    } else if (args.spaceId !== undefined) {
      const sid = args.spaceId;
      const s = await ctx.db
        .query('Space')
        .withIndex('by_app_id', (q) => q.eq('id', sid))
        .unique();
      if (s) targets = [s];
    }
    for (const s of targets) await ctx.db.patch(s._id, { companyId: undefined });
    return targets.length;
  },
});

/** Link a space to a company by space id. Mirrors manager/join + affiliates/join
 *  `.update({ companyId }).eq('id', spaceId)`. */
export const setCompanyById = mutation({
  args: { id: v.string(), companyId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const s = await ctx.db
      .query('Space')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!s) return;
    await ctx.db.patch(s._id, { companyId: args.companyId });
  },
});

/**
 * Delete a space by slug, cascading its WITHIN-DOMAIN dependents (SpaceSetting +
 * DisabledSpace, which had ON DELETE CASCADE FKs to Space). Mirrors
 * `.from('Space').delete().eq('slug', slug)`. Returns whether a row was deleted.
 *
 * NOTE: the ~30 OTHER tables with ON DELETE CASCADE to Space live in other
 * domains / still on Supabase — those cascades cannot run from here in phase 1.
 * The Space DELETE route in lib remains responsible for clearing them. This
 * mutation only guarantees the workspace-domain children are gone.
 */
export const removeBySlug = mutation({
  args: { slug: v.string() },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    const s = await ctx.db
      .query('Space')
      .withIndex('by_slug', (q) => q.eq('slug', args.slug))
      .first();
    if (!s) return { deleted: false };

    // Cascade within-domain children (PG ON DELETE CASCADE equivalents).
    const settings = await ctx.db
      .query('SpaceSetting')
      .withIndex('by_space', (q) => q.eq('spaceId', s.id))
      .collect();
    for (const row of settings) await ctx.db.delete(row._id);

    const disabled = await ctx.db
      .query('DisabledSpace')
      .withIndex('by_space_active', (q) => q.eq('spaceId', s.id))
      .collect();
    for (const row of disabled) await ctx.db.delete(row._id);

    await ctx.db.delete(s._id);
    return { deleted: true };
  },
});
