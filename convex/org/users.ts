import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * User data access — the Convex replacement for every `.from('User')` read &
 * write across lib/app/components (~183 call sites). User is the most-referenced
 * table in the codebase; it is looked up by `id`, by `clerkId` (the dominant
 * auth path), and by `email` (invite dedup), read in batches by `in('id', [...])`,
 * counted/listed for the admin dashboard, patched field-by-field through
 * onboarding/profile flows, upserted-on-clerkId at first login, and hard-deleted
 * on account deletion.
 *
 * DESIGN (CONVENTIONS "return the same shape the call site expects"): the old
 * call sites select different column subsets off the SAME filter (e.g. ten
 * distinct `.eq('clerkId', x).select(...)` projections). Rather than one Convex
 * fn per projection, we expose ONE read per distinct FILTER/index and return the
 * full mapped row; the lib (which already destructures the columns it wants) does
 * the projection. Absent optionals are coerced to null so the old `Row` shape is
 * preserved. Writes that touched only this table become single mutations; the
 * service-role posture (no auth gate) matches the old code per CONVENTIONS.
 *
 * Cross-domain note: the admin list queries embedded `Space(...)` and the account
 * export pulled a Space — those joins live OUTSIDE this domain (Space is its own
 * domain) and stay as separate lib resolutions. These User fns return User rows
 * only; the integrator's lib rewrite composes the Space side as it does today.
 */

const platformRoleValidator = v.union(
  v.literal('user'),
  v.literal('admin'),
  v.literal('banned'),
);
const accountTypeValidator = v.union(
  v.literal('seller'),
  v.literal('manager_only'),
  v.literal('both'),
);
const preferredNotificationValidator = v.union(
  v.literal('email'),
  v.literal('sms'),
  v.literal('both'),
);
const statusValidator = v.union(v.literal('active'), v.literal('offboarded'));

/** The full User row shape the call sites consume. Map `_id` away, expose the
 *  string `id`, coerce every absent optional to SQL NULL so the old `Row`/select
 *  shapes are byte-for-byte preserved. */
function toUserRow(u: Doc<'User'>) {
  return {
    id: u.id,
    clerkId: u.clerkId,
    email: u.email,
    name: u.name ?? null,
    avatar: u.avatar ?? null,
    bio: u.bio ?? null,
    createdAt: u.createdAt,
    onboardingCurrentStep: u.onboardingCurrentStep,
    onboardingStartedAt: u.onboardingStartedAt ?? null,
    onboardingCompletedAt: u.onboardingCompletedAt ?? null,
    onboard: u.onboard,
    platformRole: u.platformRole,
    accountType: u.accountType,
    phone: u.phone ?? null,
    socialLinks: u.socialLinks ?? null,
    websiteUrl: u.websiteUrl ?? null,
    mlsId: u.mlsId ?? null,
    companyAffiliation: u.companyAffiliation ?? null,
    preferredNotification: u.preferredNotification ?? null,
    timezone: u.timezone ?? null,
    referralSource: u.referralSource ?? null,
    biggestPainPoint: u.biggestPainPoint ?? null,
    status: u.status,
    offboardedAt: u.offboardedAt ?? null,
    offboardedToUserId: u.offboardedToUserId ?? null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One full User by Clerk id, or null. Covers EVERY `.eq('clerkId', x).select(
 *  ...).maybeSingle()` variant (full row, id-only, (id,status), (platformRole,
 *  status), (id,onboard,accountType,platformRole), (id,onboard,platformRole,name),
 *  (id,name,avatar), …) — the lib projects the columns it needs off this row. */
export const getByClerkId = query({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const u = await ctx.db
      .query('User')
      .withIndex('by_clerk_id', (q) => q.eq('clerkId', args.clerkId))
      .unique();
    return u ? toUserRow(u) : null;
  },
});

/** One full User by app id, or null. Covers every `.eq('id', x).select(...)
 *  .maybeSingle()` (space-owner identity on public/deal pages, account export,
 *  settlement email, inviter name). The lib projects from the full row. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const u = await ctx.db
      .query('User')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return u ? toUserRow(u) : null;
  },
});

/** One full User by email, or null. Covers the invite-dedup `.eq('email',
 *  trimmedEmail).select('id').maybeSingle()`. Email is matched case-sensitively
 *  on the trimmed value exactly as the old `.eq` did (NOT `.ilike` — no User call
 *  site uses ilike). */
export const getByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const u = await ctx.db
      .query('User')
      .withIndex('by_email', (q) => q.eq('email', args.email))
      .first();
    return u ? toUserRow(u) : null;
  },
});

/** Full Users for a set of app ids (batch). Covers `.in('id', userIds).select(
 *  ...)` (company-member name resolution, routing status fetch, admin company
 *  detail, manager products owner names). Returns mapped rows; lib projects. */
export const listByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const rows = await Promise.all(
      args.ids.map((id) =>
        ctx.db
          .query('User')
          .withIndex('by_app_id', (q) => q.eq('id', id))
          .unique(),
      ),
    );
    return rows.filter((u): u is Doc<'User'> => u !== null).map(toUserRow);
  },
});

/** Users for a set of Clerk ids (`.in('clerkId', [...])`) — the manager activity
 *  log resolves actor clerkIds to names/emails in one shot. Missing ids are
 *  dropped (same as the IN query). */
export const listByClerkIds = query({
  args: { clerkIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const rows = await Promise.all(
      args.clerkIds.map((clerkId) =>
        ctx.db
          .query('User')
          .withIndex('by_clerk_id', (q) => q.eq('clerkId', clerkId))
          .unique(),
      ),
    );
    return rows.filter((u): u is Doc<'User'> => u !== null).map(toUserRow);
  },
});

/** Admin user list. Mirrors `.select(...).eq(<onboard|platformRole>,?).order(
 *  'createdAt', desc).limit(200)`. The optional `onboard` / `platformRole`
 *  filters cover the onboarded / not-onboarded / banned tabs; absent = all.
 *  (Embedded `Space(...)` stays a separate lib resolution — cross-domain.) */
export const listForAdmin = query({
  args: {
    onboard: v.optional(v.boolean()),
    platformRole: v.optional(platformRoleValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows: Doc<'User'>[] = await ctx.db.query('User').collect();
    const filtered = rows
      .filter((u) => (args.onboard === undefined ? true : u.onboard === args.onboard))
      .filter((u) =>
        args.platformRole === undefined ? true : u.platformRole === args.platformRole,
      );
    filtered.sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
    return filtered.slice(0, args.limit ?? 200).map(toUserRow);
  },
});

/** Admin "recent signups" feed — newest-first, small limit (default 5). Mirrors
 *  `.select(...).order('createdAt', desc).limit(N)`. Embedded `Space(slug)` is a
 *  separate lib resolution. */
export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows: Doc<'User'>[] = await ctx.db.query('User').collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.slice(0, args.limit ?? 5).map(toUserRow);
  },
});

/** Admin metric counts. Mirrors the three `.select('*', { count, head }).<filter>`
 *  calls: total Users, onboarded Users (`.eq('onboard', true)`), and signups
 *  since a date (`.gte('createdAt', date)`). Returns all three so admin-metrics
 *  folds them exactly as before. `since` defaults to no lower bound. */
export const counts = query({
  args: { since: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows: Doc<'User'>[] = await ctx.db.query('User').collect();
    return {
      total: rows.length,
      onboarded: rows.filter((u) => u.onboard).length,
      sinceCount:
        args.since === undefined
          ? rows.length
          : rows.filter((u) => u.createdAt >= args.since!).length,
    };
  },
});

/** Signup time-series rows — `createdAt` for Users created since a date, ASC.
 *  Mirrors `.select('createdAt').gte('createdAt', date).order('createdAt', asc)`.
 *  Returns just the timestamps the chart aggregates client-side. */
export const createdAtsSince = query({
  args: { since: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const rows: Doc<'User'>[] = await ctx.db.query('User').collect();
    return rows
      .filter((u) => u.createdAt >= args.since)
      .map((u) => u.createdAt)
      .sort();
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Upsert a User keyed on clerkId — the first-login auto-provision path
 * (`/setup`, `/api/onboarding`, invite accept). Replaces `.upsert({...}, {
 * onConflict: 'clerkId' })`. Read-then-insert inside one mutation preserves the
 * User_clerkId_key UNIQUE invariant race-safely (stronger than the old upsert).
 *
 * On conflict (a User with this clerkId already exists) we keep the existing row
 * untouched and return it — matching Postgres `ON CONFLICT(clerkId) DO UPDATE`
 * where the provided columns equal what's already there for a returning-row read
 * (the callers only read back id/email, both stable). The caller supplies the new
 * `id`; defaults mirror the insert payloads (onboard=false, current PG column
 * defaults for everything omitted).
 */
export const upsertByClerkId = mutation({
  args: {
    id: v.string(),
    clerkId: v.string(),
    email: v.string(),
    name: v.union(v.string(), v.null()),
    avatar: v.optional(v.union(v.string(), v.null())),
    onboardingStartedAt: v.optional(v.string()),
    onboard: v.optional(v.boolean()),
    createdAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('User')
      .withIndex('by_clerk_id', (q) => q.eq('clerkId', args.clerkId))
      .unique();
    if (existing) return toUserRow(existing);

    const doc = {
      id: args.id,
      clerkId: args.clerkId,
      email: args.email,
      ...(args.name !== null ? { name: args.name } : {}),
      ...(args.avatar != null ? { avatar: args.avatar } : {}),
      createdAt: args.createdAt ?? new Date().toISOString(),
      onboardingCurrentStep: 0,
      ...(args.onboardingStartedAt !== undefined
        ? { onboardingStartedAt: args.onboardingStartedAt }
        : {}),
      onboard: args.onboard ?? false,
      platformRole: 'user' as const,
      accountType: 'seller' as const,
      // PG defaults for the rest: socialLinks {}, preferredNotification 'email',
      // timezone 'America/New_York', status 'active'.
      socialLinks: {},
      preferredNotification: 'email' as const,
      timezone: 'America/New_York',
      status: 'active' as const,
    };
    const _id = await ctx.db.insert('User', doc);
    const created = (await ctx.db.get(_id))!;
    return toUserRow(created);
  },
});

/**
 * Patch an arbitrary subset of a User's columns by app id. ONE mutation covers
 * every `.from('User').update({...}).eq('id', userId)` in the codebase: the
 * onboarding state flips (onboard/onboardingCurrentStep/onboardingStartedAt/
 * onboardingCompletedAt), the avatar/name backfills, the accountType change, and
 * the enhanced-profile bulk patch (phone, bio, socialLinks, websiteUrl, mlsId,
 * companyAffiliation, preferredNotification, timezone, referralSource,
 * biggestPainPoint). Only the fields actually provided are written. No-op if the
 * user vanished. Returns the updated row (or null).
 *
 * `expectedStatus` reproduces the conditional re-activation guard
 * (`.eq('id', userId).eq('status', 'offboarded')`): when set, the patch only
 * applies if the row's current status equals it, mirroring the CAS filter.
 */
export const updateById = mutation({
  args: {
    id: v.string(),
    expectedStatus: v.optional(statusValidator),
    patch: v.object({
      name: v.optional(v.string()),
      avatar: v.optional(v.string()),
      bio: v.optional(v.string()),
      onboard: v.optional(v.boolean()),
      onboardingCurrentStep: v.optional(v.number()),
      onboardingStartedAt: v.optional(v.string()),
      onboardingCompletedAt: v.optional(v.string()),
      platformRole: v.optional(platformRoleValidator),
      accountType: v.optional(accountTypeValidator),
      phone: v.optional(v.string()),
      socialLinks: v.optional(v.any()),
      websiteUrl: v.optional(v.string()),
      mlsId: v.optional(v.string()),
      companyAffiliation: v.optional(v.string()),
      preferredNotification: v.optional(preferredNotificationValidator),
      timezone: v.optional(v.string()),
      referralSource: v.optional(v.string()),
      biggestPainPoint: v.optional(v.string()),
      status: v.optional(statusValidator),
      offboardedAt: v.optional(v.string()),
      offboardedToUserId: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const u = await ctx.db
      .query('User')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!u) return null;
    if (args.expectedStatus !== undefined && u.status !== args.expectedStatus) {
      // CAS guard failed (e.g. user not 'offboarded') — no-op, matching the old
      // filtered update that affected 0 rows.
      return toUserRow(u);
    }
    // Drop undefined keys so we only patch what the caller supplied.
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(args.patch)) {
      if (val !== undefined) patch[k] = val;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(u._id, patch);
    const updated = (await ctx.db.get(u._id))!;
    return toUserRow(updated);
  },
});

/**
 * Hard-delete a User by app id — the account-deletion path. The old code relied
 * on Postgres ON DELETE CASCADE from User to Space (and transitively all
 * Space-scoped tables); Convex has no FK cascade, so those cascades MUST be
 * driven by lib/account-deletion.ts across the affected domains. This mutation
 * deletes ONLY the User row.
 *
 * TODO(cross-domain, integrator): lib/account-deletion.ts must orchestrate the
 * cascade — Space (and everything keyed to it), CompanyMembership rows for this
 * user, etc. — as explicit cross-domain deletes, since this mutation cannot
 * reach other domains' tables. (CompanyMembership cleanup for a deleted user is
 * available as org.memberships.deleteAllForUser.)
 */
export const deleteById = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const u = await ctx.db
      .query('User')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (u) await ctx.db.delete(u._id);
  },
});
