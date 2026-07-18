import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * CompanyMembership data access — the User↔Company join with roles (~66 call
 * sites). Looked up three ways: by `userId` (resolve a user's manager/seller
 * context, role-filtered, createdAt-ordered), by `companyId` (member lists,
 * stats, seat counts, seller_member enumeration for routing/leaderboard/publish),
 * and by the `(companyId, userId)` UNIQUE pair (every "already a member?"
 * idempotency check + scoped fetch). Written by the join/invite/create flows
 * (insert), the role route (role patch), the manager-profile route (profile
 * patch), and the member-remove/admin/offboard flows (delete).
 *
 * Role filtering: the call sites filter to sets like
 * ['manager_owner','manager_admin'] or ['seller_member']. We pass the role set as
 * an arg and filter in-handler over the small per-user / per-company result of an
 * index scan (no value-level index needed; the sets vary per call site).
 *
 * Reads return the full mapped row (lib projects); writes touching only this
 * table are single mutations. The offboard stored proc is reimplemented here as
 * `offboardMember` — see its docstring for the exact cross-domain boundary.
 */

const roleValidator = v.union(
  v.literal('manager_owner'),
  v.literal('manager_admin'),
  v.literal('seller_member'),
);

/** The full CompanyMembership row the call sites consume. */
function toMembershipRow(m: Doc<'CompanyMembership'>) {
  return {
    id: m.id,
    companyId: m.companyId,
    userId: m.userId,
    role: m.role,
    invitedById: m.invitedById ?? null,
    createdAt: m.createdAt,
    displayName: m.displayName ?? null,
    title: m.title ?? null,
    bio: m.bio ?? null,
    photoUrl: m.photoUrl ?? null,
    phone: m.phone ?? null,
  };
}

function sortByCreatedAtAsc(rows: Doc<'CompanyMembership'>[]) {
  return rows
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A user's memberships, optionally restricted to a role set, createdAt ASC.
 *  Covers the auth/permissions resolution (`.eq('userId', x).in('role', [...]).
 *  order('createdAt', asc)`) and the sidebar/tool variants. `roles` absent = all
 *  roles. The lib projects whichever columns it reads (and composes any embedded
 *  Company separately — cross-domain composition stays lib-side). */
export const listByUser = query({
  args: { userId: v.string(), roles: v.optional(v.array(roleValidator)) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    const filtered =
      args.roles === undefined ? rows : rows.filter((m) => args.roles!.includes(m.role));
    return sortByCreatedAtAsc(filtered).map(toMembershipRow);
  },
});

/** A company's memberships, optionally restricted to a role set, createdAt ASC.
 *  Covers member lists, stats/activity rollups (which only need userId/role), the
 *  seller_member enumeration for routing/leaderboard/template-publish, and the
 *  admin per-company member fetch. `roles` absent = all. */
export const listByCompany = query({
  args: { companyId: v.string(), roles: v.optional(v.array(roleValidator)) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .collect();
    const filtered =
      args.roles === undefined ? rows : rows.filter((m) => args.roles!.includes(m.role));
    return sortByCreatedAtAsc(filtered).map(toMembershipRow);
  },
});

/** Memberships across a set of companies (admin per-company member counts —
 *  `.in('companyId', ids).select('companyId')`). Returns full rows; lib tallies
 *  by companyId. */
export const listByCompanyIds = query({
  args: { companyIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const rows = await Promise.all(
      args.companyIds.map((cid) =>
        ctx.db
          .query('CompanyMembership')
          .withIndex('by_company', (q) => q.eq('companyId', cid))
          .collect(),
      ),
    );
    return rows.flat().map(toMembershipRow);
  },
});

/** The membership for a (companyId, userId) pair, or null. Covers every
 *  "already a member?" idempotency check and scoped seller fetch
 *  (`.eq('companyId').eq('userId').maybeSingle()`). */
export const getByCompanyUser = query({
  args: { companyId: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    const m = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_company_user', (q) =>
        q.eq('companyId', args.companyId).eq('userId', args.userId),
      )
      .unique();
    return m ? toMembershipRow(m) : null;
  },
});

/** A membership by app id, scoped to a company (the [id] member routes:
 *  `.eq('id', membershipId).eq('companyId', x).maybeSingle()`). Returns null if
 *  the row is absent OR belongs to another company (no cross-company leak,
 *  matching the old two-filter query). */
export const getByIdScoped = query({
  args: { id: v.string(), companyId: v.string() },
  handler: async (ctx, args) => {
    const m = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!m || m.companyId !== args.companyId) return null;
    return toMembershipRow(m);
  },
});

/** One membership by id alone (no company scope), or null. The admin
 *  membership-by-id read that needs to DISCOVER the companyId (`.eq('id', id)
 *  .maybeSingle()`). */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const m = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return m ? toMembershipRow(m) : null;
  },
});

/** Total seat usage for a company — the member count (`.select('*', { count,
 *  head }).eq('companyId', x)`) and, optionally, the seller_member-only count
 *  (settings page). Returns both so callers pick the one they need. */
export const countByCompany = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .collect();
    return {
      total: rows.length,
      sellerMembers: rows.filter((m) => m.role === 'seller_member').length,
    };
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

export interface CreateMembershipResult {
  /** 'created' = inserted. 'exists' = a membership for this (companyId, userId)
   *  already existed (the join/invite paths pre-checked and returned "already a
   *  member"); we return the existing row so the lib can short-circuit. */
  outcome: 'created' | 'exists';
  membership: ReturnType<typeof toMembershipRow>;
}

/**
 * Create a membership. Replaces the `.insert({...})` in the create / join / invite
 * paths. Preserves CompanyMembership_companyId_userId_key UNIQUE via a
 * read-then-insert on by_company_user inside this mutation (the old code did a
 * separate "already a member?" pre-check then inserted; folding them removes the
 * race). `id` is generated here when not supplied (some call sites passed an
 * explicit uuid, others let PG default it). `role`/`invitedById` come from the
 * caller (join → seller_member, invite → inv.roleToAssign + invitedById).
 */
export const create = mutation({
  args: {
    companyId: v.string(),
    userId: v.string(),
    role: roleValidator,
    invitedById: v.optional(v.union(v.string(), v.null())),
    id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CreateMembershipResult> => {
    const existing = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_company_user', (q) =>
        q.eq('companyId', args.companyId).eq('userId', args.userId),
      )
      .unique();
    if (existing) return { outcome: 'exists', membership: toMembershipRow(existing) };

    const doc = {
      id: args.id ?? crypto.randomUUID(),
      companyId: args.companyId,
      userId: args.userId,
      role: args.role,
      ...(args.invitedById != null ? { invitedById: args.invitedById } : {}),
      createdAt: new Date().toISOString(),
    };
    const _id = await ctx.db.insert('CompanyMembership', doc);
    const created = (await ctx.db.get(_id))!;
    return { outcome: 'created', membership: toMembershipRow(created) };
  },
});

/** Change a member's role, scoped to a company. Mirrors `.update({ role }).eq(
 *  'id', membershipId).eq('companyId', x)`. No-op (returns null) if the row is
 *  absent or belongs to another company. */
export const updateRole = mutation({
  args: { id: v.string(), companyId: v.string(), role: roleValidator },
  handler: async (ctx, args) => {
    const m = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!m || m.companyId !== args.companyId) return null;
    await ctx.db.patch(m._id, { role: args.role });
    const updated = (await ctx.db.get(m._id))!;
    return toMembershipRow(updated);
  },
});

/** Patch a member's own profile fields by membership id (the manager-profile
 *  route: `.update({ displayName?, title?, bio?, photoUrl?, phone? }).eq('id',
 *  membershipId)`). Only provided fields are written; null clears a field. No-op
 *  if absent. */
export const updateProfile = mutation({
  args: {
    id: v.string(),
    patch: v.object({
      displayName: v.optional(v.union(v.string(), v.null())),
      title: v.optional(v.union(v.string(), v.null())),
      bio: v.optional(v.union(v.string(), v.null())),
      photoUrl: v.optional(v.union(v.string(), v.null())),
      phone: v.optional(v.union(v.string(), v.null())),
    }),
  },
  handler: async (ctx, args) => {
    const m = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!m) return null;
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(args.patch)) {
      if (val !== undefined) patch[k] = val;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(m._id, patch);
    const updated = (await ctx.db.get(m._id))!;
    return toMembershipRow(updated);
  },
});

/** Delete a membership by id, scoped to a company (manager member-remove:
 *  `.delete().eq('id', membershipId).eq('companyId', x)`). The companyId scope is
 *  the TOCTOU guard the old route added. Returns true if a row was deleted. */
export const deleteByIdScoped = mutation({
  args: { id: v.string(), companyId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const m = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!m || m.companyId !== args.companyId) return false;
    await ctx.db.delete(m._id);
    return true;
  },
});

/** Delete a membership by id, unscoped (admin membership delete:
 *  `.delete().eq('id', id)`). Returns true if a row was deleted. */
export const deleteById = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const m = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!m) return false;
    await ctx.db.delete(m._id);
    return true;
  },
});

/** Delete EVERY membership for a user (the account-deletion cascade's
 *  CompanyMembership leg — Postgres did this via ON DELETE CASCADE from User).
 *  Exposed so lib/account-deletion.ts can drive the cross-domain cascade
 *  explicitly. Returns the count removed. */
export const deleteAllForUser = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    for (const m of rows) await ctx.db.delete(m._id);
    return rows.length;
  },
});

// ── CompanyRemoval (the removal deny-list) ───────────────────────────────────
//
// CompanyRemoval is the deny-list that stops a removed agent from silently
// rejoining via the still-circulating join code. It has no surrogate id —
// PRIMARY KEY(companyId, userId) is its identity. Only two call sites touch it:
// the join path reads "was this user removed from this company?", and the
// member-remove path upserts (ON CONFLICT(companyId,userId) DO NOTHING). It lives
// here because it's the tail of the membership-removal lifecycle.

/** Is this (companyId, userId) on the removal deny-list? Mirrors the join path's
 *  `.eq('companyId').eq('userId').select('companyId').maybeSingle()` — returns
 *  true if a removal row exists. */
export const isRemoved = query({
  args: { companyId: v.string(), userId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query('CompanyRemoval')
      .withIndex('by_company_user', (q) =>
        q.eq('companyId', args.companyId).eq('userId', args.userId),
      )
      .unique();
    return row !== null;
  },
});

/** Record a removal (deny-list upsert). Replaces `.upsert({ companyId, userId,
 *  removedById }, { onConflict: 'companyId,userId' })`. Read-then-skip-or-insert
 *  preserves the PRIMARY KEY(companyId, userId) "DO NOTHING" semantics: if a row
 *  already exists we leave it (the proc's ON CONFLICT DO NOTHING — we do NOT
 *  overwrite removedById/removedAt/reason on a replay). removedById may be null
 *  (clerkId→User.id resolution can miss in edge cases). */
export const recordRemoval = mutation({
  args: {
    companyId: v.string(),
    userId: v.string(),
    removedById: v.optional(v.union(v.string(), v.null())),
    reason: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query('CompanyRemoval')
      .withIndex('by_company_user', (q) =>
        q.eq('companyId', args.companyId).eq('userId', args.userId),
      )
      .unique();
    if (existing) return; // ON CONFLICT DO NOTHING
    await ctx.db.insert('CompanyRemoval', {
      companyId: args.companyId,
      userId: args.userId,
      removedAt: new Date().toISOString(),
      ...(args.removedById != null ? { removedById: args.removedById } : {}),
      ...(args.reason != null ? { reason: args.reason } : {}),
    });
  },
});

// ── offboard_company_member (Postgres stored proc → Convex mutation) ──────────

export interface OffboardResult {
  /** Counts of records moved (real run) or that WOULD move (dry run). Names
   *  mirror the proc's json_build_object keys the route reads. */
  contactCount: number;
  dealCount: number;
  demoCount: number;
  /** Whether this was a dry run (no writes applied). */
  dryRun: boolean;
}

/** Is the offboard destination user present AND status='active'? The integrator
 *  calls this BEFORE running the cross-domain transfer, reproducing the proc's
 *  top-of-body guard (don't transfer data toward a non-active user). The proc
 *  COALESCE(status,'active')'d a missing column; our schema always has status, so
 *  a plain check matches. Returns false if the user is missing OR not active. */
export const destinationActive = query({
  args: { destinationUserId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const dest = await ctx.db
      .query('User')
      .withIndex('by_app_id', (q) => q.eq('id', args.destinationUserId))
      .unique();
    return dest !== null && dest.status === 'active';
  },
});

/**
 * Reimplementation of the Postgres `offboard_company_member(p_leaving_user_id,
 * p_destination_user_id, p_company_id, p_dry_run)` stored proc — the member
 * offboarding cascade. Called today via `supabase.rpc('offboard_company_member',
 * ...)` from app/api/manager/members/[id]/offboard/route.ts.
 *
 * THIS DOMAIN'S PART (done here, atomically): on a real run, after the transfer,
 *   1. DELETE the leaving user's CompanyMembership for this company.
 *   2. Flip User.offboardedAt + offboardedToUserId = now()/destination, ALWAYS.
 *      ALSO flip User.status='offboarded' ONLY IF this was the user's LAST
 *      remaining membership (a dual-company seller leaving one company keeps
 *      status 'active' so their other membership keeps working — the proc's exact
 *      branch; the API auth gate treats 'offboarded' as a hard account stop).
 *   3. Guard: the destination User must exist and be status='active' (the proc's
 *      hardened pre-check; we RAISE-equivalent by throwing).
 *
 * CROSS-DOMAIN PART (NOT done here — flagged for the integrator): the proc also
 * resolves the leaving/destination Spaces (Space.ownerId, locked FOR UPDATE),
 * computes the move set, and REASSIGNS spaceId on Contact, ContactActivity, Deal,
 * DealActivity, DealChecklistItem, and Demo (open demos), plus produces the
 * contact/deal/demo COUNTS. Those tables are ALL outside the org domain (Contact/
 * Deal/Demo domains) and cannot be touched from this mutation. The integrator
 * must drive the transfer + counts via the owning domains' fns and PASS the
 * resulting counts in (`contactCount`/`dealCount`/`demoCount`), and must perform
 * the dry-run counting cross-domain too. The exact transfer SQL (verbatim from
 * supabase/migrations/20260508000000_offboarding_hardening.sql) is reproduced in
 * the TODO below so the integrator can port it 1:1.
 *
 * Ordering vs. the proc: the proc checks destination-active FIRST (before any
 * counting or transfer), then does the transfer, then deletes the membership /
 * flips the user — all in one transaction. Since we can't span domains in one
 * Convex mutation, the integrator should: (1) call `destinationActive` up front
 * and bail on false BEFORE touching anything (matching the proc's top-of-body
 * guard — don't move data toward an offboarded user); (2) run the cross-domain
 * transfer; (3) call this mutation with dryRun=false to finish the within-domain
 * state change. This mutation RE-checks destination-active (defense in depth,
 * exactly as the hardened migration did) and throws if it regressed. On a dry run
 * it makes NO writes and simply echoes the passed-in counts.
 *
 * NOTE on atomicity: the original proc was atomic; this phase-1 split is not (a
 * throw here leaves an already-applied cross-domain transfer in place). That is
 * the accepted Wave-A tradeoff per CONVENTIONS ("do NOT fold another domain's
 * writes into your mutation in phase 1; collapsing whole flows is phase-2
 * hardening"). The up-front `destinationActive` guard makes the throw path here
 * vanishingly unlikely in practice.
 *
 * TODO(cross-domain, integrator) — port verbatim from the hardened migration:
 *   - lock leaving Space by ownerId=p_leaving_user_id; error if none.
 *   - lock destination Space by ownerId=p_destination_user_id; error if none.
 *   - error if leaving Space == destination Space.
 *   - move set: Contact WHERE spaceId=leavingSpace AND companyId=p_company_id;
 *     Deal WHERE spaceId=leavingSpace AND EXISTS(DealContact.dealId=Deal.id AND
 *     DealContact.contactId IN movedContacts).
 *   - counts: |movedContacts|, |movedDeals|, and Demo WHERE spaceId=leavingSpace
 *     AND contactId IN movedContacts AND startsAt>=now() (openDemoCount).
 *   - real-run UPDATEs (set spaceId=destinationSpace): Contact (id IN moved),
 *     ContactActivity (spaceId=leaving AND contactId IN moved), Deal (id IN
 *     moved), DealActivity (spaceId=leaving AND dealId IN moved),
 *     DealChecklistItem (spaceId=leaving AND dealId IN moved), Demo (spaceId=
 *     leaving AND contactId IN moved).
 */
export const offboardMember = mutation({
  args: {
    leavingUserId: v.string(),
    destinationUserId: v.string(),
    companyId: v.string(),
    dryRun: v.boolean(),
    // Counts computed cross-domain by the integrator (Contact/Deal/Demo domains).
    // On a dry run these are echoed back as the "would move" totals; on a real
    // run they are the actually-moved totals to return to the route.
    contactCount: v.number(),
    dealCount: v.number(),
    demoCount: v.number(),
  },
  handler: async (ctx, args): Promise<OffboardResult> => {
    // Destination must exist and be active (the proc's hardened guard). Throwing
    // is the Convex analogue of the proc's RAISE EXCEPTION — the route's old
    // rpcError branch maps this to a 500/"Transfer failed".
    const dest = await ctx.db
      .query('User')
      .withIndex('by_app_id', (q) => q.eq('id', args.destinationUserId))
      .unique();
    if (!dest) {
      throw new Error(`Destination user ${args.destinationUserId} not found`);
    }
    // COALESCE(status,'active') ⇒ a missing status was treated as active; our
    // schema always has status, so a plain check suffices.
    if (dest.status !== 'active') {
      throw new Error(
        `Destination user ${args.destinationUserId} is not active (status=${dest.status})`,
      );
    }

    if (args.dryRun) {
      // No writes — echo the cross-domain counts, exactly as the proc's dry-run
      // branch returned counts without applying the transfer.
      return {
        contactCount: args.contactCount,
        dealCount: args.dealCount,
        demoCount: args.demoCount,
        dryRun: true,
      };
    }

    // Real run, within-domain state change (the cross-domain transfer has already
    // been applied by the integrator before this call):

    // 1. Remove the leaving user's membership for THIS company.
    const membership = await ctx.db
      .query('CompanyMembership')
      .withIndex('by_company_user', (q) =>
        q.eq('companyId', args.companyId).eq('userId', args.leavingUserId),
      )
      .unique();
    if (membership) await ctx.db.delete(membership._id);

    // 2. Flip the leaving user. offboardedAt + offboardedToUserId are ALWAYS set
    //    (audit trail for this transfer). status flips to 'offboarded' ONLY if no
    //    membership remains for the user — the proc's dual-company branch.
    const leaving = await ctx.db
      .query('User')
      .withIndex('by_app_id', (q) => q.eq('id', args.leavingUserId))
      .unique();
    if (leaving) {
      const remaining = await ctx.db
        .query('CompanyMembership')
        .withIndex('by_user', (q) => q.eq('userId', args.leavingUserId))
        .first();
      const now = new Date().toISOString();
      await ctx.db.patch(leaving._id, {
        offboardedAt: now,
        offboardedToUserId: args.destinationUserId,
        ...(remaining === null ? { status: 'offboarded' as const } : {}),
      });
    }

    return {
      contactCount: args.contactCount,
      dealCount: args.dealCount,
      demoCount: args.demoCount,
      dryRun: false,
    };
  },
});
