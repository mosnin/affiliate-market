import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * Company data access — the Convex replacement for every `.from('Company')` read
 * & write (~61 call sites). A Company is looked up by `id` (the common case), by
 * `ownerId` (one-company-per-owner check), by `joinCode` (invite-code resolution
 * + collision check), by Stripe ids (webhook reconciliation), and by `status`
 * (admin/cron active-company enumeration). It is created once per owner, patched
 * field-by-field (settings, billing webhooks, join-code regen, round-robin
 * cursor, admin suspend/activate), and hard-deleted by admin with a cascade.
 *
 * As with users.ts, reads are collapsed by FILTER not projection: one fn per
 * index, returning the full mapped row; the lib projects the columns it reads.
 * Writes touching only Company are single mutations. No auth gate (service-role
 * posture, per CONVENTIONS).
 *
 * Money note: Company carries Stripe linkage + plan/seat fields but NO cents
 * columns; `defaultAgentRate`/`defaultManagerRate` are commission-rate percents
 * (numeric), not money — stored verbatim, never recomputed.
 */

const statusValidator = v.union(v.literal('active'), v.literal('suspended'));
const planValidator = v.union(
  v.literal('starter'),
  v.literal('team'),
  v.literal('team_plus'),
  v.literal('enterprise'),
);
const subStatusValidator = v.union(
  v.literal('active'),
  v.literal('trialing'),
  v.literal('past_due'),
  v.literal('canceled'),
  v.literal('unpaid'),
  v.literal('inactive'),
);
const assignmentMethodValidator = v.union(
  v.literal('manual'),
  v.literal('round_robin'),
  v.literal('score_based'),
);
const leadRoutingRuleValidator = v.union(
  v.literal('manual'),
  v.literal('round_robin'),
  v.literal('fewest_active'),
);
const companyTypeValidator = v.union(
  v.literal('independent'),
  v.literal('franchise'),
  v.literal('virtual'),
);
const primaryMarketValidator = v.union(
  v.literal('residential_rental'),
  v.literal('commercial'),
  v.literal('mixed'),
);
const commissionStructureValidator = v.union(
  v.literal('flat_fee'),
  v.literal('percentage_split'),
  v.literal('hybrid'),
);

/** The full Company row the call sites consume. Map `_id` away, expose string
 *  `id`, coerce absent optionals to SQL NULL. */
function toCompanyRow(c: Doc<'Company'>) {
  return {
    id: c.id,
    name: c.name,
    ownerId: c.ownerId,
    status: c.status,
    websiteUrl: c.websiteUrl ?? null,
    logoUrl: c.logoUrl ?? null,
    joinCode: c.joinCode ?? null,
    companyFormConfig: c.companyFormConfig ?? null,
    companyRentalFormConfig: c.companyRentalFormConfig ?? null,
    companyBuyerFormConfig: c.companyBuyerFormConfig ?? null,
    companyRentalScoringModel: c.companyRentalScoringModel ?? null,
    companyBuyerScoringModel: c.companyBuyerScoringModel ?? null,
    createdAt: c.createdAt,
    privacyPolicyHtml: c.privacyPolicyHtml ?? null,
    officeAddress: c.officeAddress ?? null,
    officePhone: c.officePhone ?? null,
    agentCount: c.agentCount ?? null,
    companyType: c.companyType ?? null,
    primaryMarket: c.primaryMarket ?? null,
    commissionStructure: c.commissionStructure ?? null,
    geographicCoverage: c.geographicCoverage ?? null,
    defaultAgentRate: c.defaultAgentRate,
    defaultManagerRate: c.defaultManagerRate,
    plan: c.plan,
    seatLimit: c.seatLimit ?? null,
    stripeCustomerId: c.stripeCustomerId ?? null,
    stripeSubscriptionId: c.stripeSubscriptionId ?? null,
    stripeSubscriptionStatus: c.stripeSubscriptionStatus,
    stripePeriodEnd: c.stripePeriodEnd ?? null,
    autoAssignEnabled: c.autoAssignEnabled,
    assignmentMethod: c.assignmentMethod,
    lastAssignedUserId: c.lastAssignedUserId ?? null,
    companyLicenseNumber: c.companyLicenseNumber ?? null,
    companyFairHousingNotice: c.companyFairHousingNotice ?? null,
    companyShowEqualHousingMark: c.companyShowEqualHousingMark,
    leadRoutingRule: c.leadRoutingRule,
    slaEnabled: c.slaEnabled,
    slaFirstResponseMinutes: c.slaFirstResponseMinutes,
    slaEscalateMinutes: c.slaEscalateMinutes,
    planActivatedAt: c.planActivatedAt ?? null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One full Company by app id, or null. Covers every `.eq('id', x).select(...)
 *  .maybeSingle()` (settings, billing/account, seats, permissions, apply pages,
 *  routing config, webhook safety check, post-PATCH read). Lib projects. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('Company')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return c ? toCompanyRow(c) : null;
  },
});

/** One full Company by owner id, or null. Covers the "does this user already own
 *  a company?" pre-check (`.eq('ownerId', x).select('id').maybeSingle()`) which
 *  also backs the create-uniqueness read. */
export const getByOwner = query({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('Company')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
      .first();
    return c ? toCompanyRow(c) : null;
  },
});

/** One full Company by join code, or null. Covers the join-page / join-API
 *  resolution (`.eq('joinCode', code).select('id, name, status').maybeSingle()`)
 *  and the collision check on regenerate. */
export const getByJoinCode = query({
  args: { joinCode: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('Company')
      .withIndex('by_join_code', (q) => q.eq('joinCode', args.joinCode))
      .first();
    return c ? toCompanyRow(c) : null;
  },
});

/** One full Company by Stripe subscription id, or null (webhook reconciliation). */
export const getByStripeSubscription = query({
  args: { subscriptionId: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('Company')
      .withIndex('by_stripe_subscription', (q) =>
        q.eq('stripeSubscriptionId', args.subscriptionId),
      )
      .first();
    return c ? toCompanyRow(c) : null;
  },
});

/** Full Companies for a set of app ids (batch). Covers `.in('id', ids)` in admin
 *  views. Returns mapped rows; lib projects + composes member counts. */
export const listByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const rows = await Promise.all(
      args.ids.map((id) =>
        ctx.db
          .query('Company')
          .withIndex('by_app_id', (q) => q.eq('id', id))
          .unique(),
      ),
    );
    return rows.filter((c): c is Doc<'Company'> => c !== null).map(toCompanyRow);
  },
});

/** All Companies, newest-first. Covers the admin company list (`.select(...,
 *  User!ownerId(...)).order('createdAt', desc)`). The embedded owner `User(...)`
 *  is a separate lib resolution (cross-domain to this fn's perspective — User is
 *  in this domain too but composed lib-side, mirroring the old PostgREST embed). */
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const rows: Doc<'Company'>[] = await ctx.db.query('Company').collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.map(toCompanyRow);
  },
});

/** Active companies for the weekly-report cron (`.eq('status', 'active').select(
 *  'id, name, ownerId, logoUrl')`). Returns full rows; lib projects. */
export const listByStatus = query({
  args: { status: statusValidator },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Company')
      .withIndex('by_status', (q) => q.eq('status', args.status))
      .collect();
    return rows.map(toCompanyRow);
  },
});

/** Companies with an active-ish subscription, for the admin billing page.
 *  Mirrors `.neq('stripeSubscriptionStatus', 'inactive').order('stripePeriodEnd',
 *  desc, nullsLast).limit(50)`. No PG index on the status column alone existed;
 *  the old query scanned. Returns full rows; lib projects. */
export const listBillingActive = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows: Doc<'Company'>[] = await ctx.db.query('Company').collect();
    const active = rows.filter((c) => c.stripeSubscriptionStatus !== 'inactive');
    // order by stripePeriodEnd desc, nulls last.
    active.sort((a, b) => {
      const ap = a.stripePeriodEnd ?? null;
      const bp = b.stripePeriodEnd ?? null;
      if (ap === null && bp === null) return 0;
      if (ap === null) return 1; // nulls last
      if (bp === null) return -1;
      return ap < bp ? 1 : ap > bp ? -1 : 0;
    });
    return active.slice(0, args.limit ?? 50).map(toCompanyRow);
  },
});

/** All Companies' (plan, stripeSubscriptionStatus) for the MRR metric
 *  (`.select('plan, stripeSubscriptionStatus')`, no filter). Returns just those
 *  columns so admin-metrics aggregates exactly as before. */
export const planStatuses = query({
  args: {},
  handler: async (ctx) => {
    const rows: Doc<'Company'>[] = await ctx.db.query('Company').collect();
    return rows.map((c) => ({
      plan: c.plan,
      stripeSubscriptionStatus: c.stripeSubscriptionStatus,
    }));
  },
});

/** Total Company count + active count, for admin metrics (the two `.select('*',
 *  { count, head }).<filter>` calls: all + `.eq('status','active')`). */
export const counts = query({
  args: {},
  handler: async (ctx) => {
    const rows: Doc<'Company'>[] = await ctx.db.query('Company').collect();
    return {
      total: rows.length,
      active: rows.filter((c) => c.status === 'active').length,
    };
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

export interface CreateCompanyResult {
  /** 'created' = inserted. 'owner_taken' = this owner already has a company (the
   *  old code surfaced PG 23505 on the ownerId UNIQUE as a 409); the lib maps
   *  this to the same conflict response. */
  outcome: 'created' | 'owner_taken';
  company: ReturnType<typeof toCompanyRow> | null;
}

/**
 * Create a company. Replaces the `.insert({...}).select().single()` in
 * /api/manager/create. Preserves the Company_ownerId_key UNIQUE invariant via a
 * read-then-insert on by_owner inside this mutation (race-safe; the old code did
 * a separate pre-check + relied on the unique index). Defaults mirror PG for the
 * columns the insert omits.
 */
export const create = mutation({
  args: {
    id: v.string(),
    name: v.string(),
    ownerId: v.string(),
    logoUrl: v.optional(v.union(v.string(), v.null())),
    websiteUrl: v.optional(v.union(v.string(), v.null())),
    officeAddress: v.optional(v.union(v.string(), v.null())),
    officePhone: v.optional(v.union(v.string(), v.null())),
    agentCount: v.optional(v.union(v.string(), v.null())),
    // Enum args carry their real union validators so Convex validates them at the
    // boundary exactly as the old PG CHECK constraints did (no string casts).
    companyType: v.optional(v.union(companyTypeValidator, v.null())),
    primaryMarket: v.optional(v.union(primaryMarketValidator, v.null())),
    commissionStructure: v.optional(v.union(commissionStructureValidator, v.null())),
    geographicCoverage: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<CreateCompanyResult> => {
    const existing = await ctx.db
      .query('Company')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
      .first();
    if (existing) return { outcome: 'owner_taken', company: toCompanyRow(existing) };

    const set = <T>(val: T | null | undefined): val is T => val != null;
    const doc = {
      id: args.id,
      name: args.name,
      ownerId: args.ownerId,
      status: 'active' as const,
      ...(set(args.logoUrl) ? { logoUrl: args.logoUrl } : {}),
      ...(set(args.websiteUrl) ? { websiteUrl: args.websiteUrl } : {}),
      ...(set(args.officeAddress) ? { officeAddress: args.officeAddress } : {}),
      ...(set(args.officePhone) ? { officePhone: args.officePhone } : {}),
      ...(set(args.agentCount) ? { agentCount: args.agentCount } : {}),
      ...(set(args.companyType) ? { companyType: args.companyType } : {}),
      ...(set(args.primaryMarket) ? { primaryMarket: args.primaryMarket } : {}),
      ...(set(args.commissionStructure)
        ? { commissionStructure: args.commissionStructure }
        : {}),
      ...(set(args.geographicCoverage)
        ? { geographicCoverage: args.geographicCoverage }
        : {}),
      createdAt: new Date().toISOString(),
      // PG defaults for everything else.
      defaultAgentRate: 2.5,
      defaultManagerRate: 0.5,
      plan: 'starter' as const,
      stripeSubscriptionStatus: 'inactive' as const,
      autoAssignEnabled: false,
      assignmentMethod: 'manual' as const,
      companyShowEqualHousingMark: false,
      leadRoutingRule: 'manual' as const,
      slaEnabled: false,
      slaFirstResponseMinutes: 60,
      slaEscalateMinutes: 120,
    };
    const _id = await ctx.db.insert('Company', doc);
    const created = (await ctx.db.get(_id))!;
    return { outcome: 'created', company: toCompanyRow(created) };
  },
});

/**
 * Patch an arbitrary subset of a Company's columns by app id. ONE mutation covers
 * every `.from('Company').update({...}).eq('id', companyId)`: the join-code regen,
 * the settings PATCH (routing + SLA + profile + fair-housing fields), the
 * round-robin `lastAssignedUserId` cursor, the four Stripe-webhook updates
 * (subscription created/updated, deleted→canceled, payment_failed→past_due), and
 * the admin status toggle. Only provided fields are written. No-op if the company
 * vanished. Returns the updated row (or null).
 *
 * Uniqueness note: `joinCode` carries a UNIQUE constraint; the join-code regen
 * route already mints a code it verified collision-free via getByJoinCode before
 * calling this. `stripeSubscriptionId` is UNIQUE-when-not-null; the webhook is the
 * single writer keyed off Stripe's own unique id, so no extra read is needed here.
 */
export const updateById = mutation({
  args: {
    id: v.string(),
    patch: v.object({
      name: v.optional(v.string()),
      status: v.optional(statusValidator),
      websiteUrl: v.optional(v.union(v.string(), v.null())),
      logoUrl: v.optional(v.union(v.string(), v.null())),
      joinCode: v.optional(v.string()),
      privacyPolicyHtml: v.optional(v.union(v.string(), v.null())),
      companyLicenseNumber: v.optional(v.union(v.string(), v.null())),
      companyFairHousingNotice: v.optional(v.union(v.string(), v.null())),
      companyShowEqualHousingMark: v.optional(v.boolean()),
      autoAssignEnabled: v.optional(v.boolean()),
      assignmentMethod: v.optional(assignmentMethodValidator),
      lastAssignedUserId: v.optional(v.union(v.string(), v.null())),
      leadRoutingRule: v.optional(leadRoutingRuleValidator),
      slaEnabled: v.optional(v.boolean()),
      slaFirstResponseMinutes: v.optional(v.number()),
      slaEscalateMinutes: v.optional(v.number()),
      plan: v.optional(planValidator),
      seatLimit: v.optional(v.union(v.number(), v.null())),
      stripeCustomerId: v.optional(v.union(v.string(), v.null())),
      stripeSubscriptionId: v.optional(v.union(v.string(), v.null())),
      stripeSubscriptionStatus: v.optional(subStatusValidator),
      stripePeriodEnd: v.optional(v.union(v.string(), v.null())),
      planActivatedAt: v.optional(v.union(v.string(), v.null())),
    }),
  },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('Company')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c) return null;
    // Drop undefined keys; pass null through (PostgREST update could set NULL).
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(args.patch)) {
      if (val !== undefined) patch[k] = val;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(c._id, patch);
    const updated = (await ctx.db.get(c._id))!;
    return toCompanyRow(updated);
  },
});

/**
 * Admin hard-delete a company WITH its within-domain cascade. The old route did
 * four sequential writes: unlink member Spaces (companyId→NULL), delete all
 * CompanyMembership for the company, delete all Invitation for the company, then
 * delete the Company. This mutation does the THREE that live in this domain —
 * CompanyMembership + Invitation deletes and the Company delete — atomically.
 *
 * TODO(cross-domain, integrator): Space.companyId unlink (Space is its own
 * domain) cannot be done from this mutation — the lib rewrite must call the
 * Space-domain "unlink company" fn BEFORE this, exactly as the old route
 * unlinked spaces first. Returns true if the company existed and was deleted.
 */
export const deleteWithCascade = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const c = await ctx.db
      .query('Company')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c) return false;

    const memberships = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_company', (q) => q.eq('companyId', args.id))
      .collect();
    for (const m of memberships) await ctx.db.delete(m._id);

    const invitations = await ctx.db
      .query('Invitation')
      .withIndex('by_company', (q) => q.eq('companyId', args.id))
      .collect();
    for (const inv of invitations) await ctx.db.delete(inv._id);

    await ctx.db.delete(c._id);
    return true;
  },
});
