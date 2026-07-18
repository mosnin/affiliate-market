import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Org domain tables — the people/company backbone of Cola: platform users, the
 * companies (brokerages/teams) they belong to, the membership join with roles,
 * the company template library, the removal deny-list, and email invitations.
 *
 * See convex/CONVENTIONS.md for the Postgres -> Convex translation rules every
 * table here follows: keep the app's `gen_random_uuid()::text` PK as
 * `id: v.string()` (relationships, Clerk metadata, invite URLs, cookies all key
 * off this string id, NOT Convex's native `_id`); TIMESTAMPTZ -> `v.string()`
 * holding ISO-8601; `CHECK col IN (...)` -> `v.union(v.literal(...))`; nullable
 * -> `v.optional`; jsonb -> `v.any()`; integer counts -> `v.number()`; bool ->
 * `v.boolean()`. Index `id` as `by_app_id` ONLY where code looks a row up by id;
 * never name an index `by_id`/`by_creation_time` (reserved).
 *
 * Postgres uniqueness / cascade invariants that encode real business behavior
 * (no native Convex equivalent) are re-implemented as read-then-insert/patch
 * inside the mutations (serializable within one mutation). Noted per table:
 *   - User_clerkId_key UNIQUE(clerkId): one User per Clerk identity — the
 *     upsertByClerkId mutation reads by_clerk_id then inserts-or-returns.
 *   - Company_ownerId_key / idx_company_owner UNIQUE(ownerId): one company per
 *     owner — create reads by_owner first (the old code did the same pre-check).
 *   - Company_joinCode_key UNIQUE(joinCode): join-code lookups + collision check
 *     on regenerate read by_join_code.
 *   - uq_company_stripe_subscription UNIQUE(stripeSubscriptionId) WHERE NOT NULL.
 *   - CompanyMembership_companyId_userId_key UNIQUE(companyId, userId): one
 *     membership per (company, user) — every "already a member?" check + insert
 *     reads by_company_user.
 *   - CompanyRemoval_pkey PRIMARY KEY(companyId, userId): the deny-list upsert
 *     (ON CONFLICT DO NOTHING) reads by_company_user then inserts-or-skips.
 *   - Invitation_token_key UNIQUE(token): token lookups read by_token.
 *   - uq_invitation_pending_email UNIQUE(companyId, lower(email)) WHERE
 *     status='pending': one open invite per (company, email) — the invite paths
 *     pre-check by_company_email_status (lowercased) before insert.
 *
 * The Postgres `offboard_company_member(...)` stored proc and the company/admin
 * delete cascades that the code relies on are re-implemented as explicit Convex
 * mutations in convex/org/memberships.ts + convex/org/companies.ts. Cascade /
 * reassignment to tables OUTSIDE this domain (Space, Contact, Deal, Demo, etc.)
 * cannot be enforced from a Convex mutation here and is flagged as a cross-domain
 * TODO for the integrator (see those modules).
 */
export const orgTables = {
  // Was: "User" (TEXT id [app-supplied, NOT gen_random_uuid here — callers mint
  // it], clerkId UNIQUE, email, name nullable, avatar nullable, bio nullable,
  // createdAt, onboardingCurrentStep int default 0, onboardingStartedAt nullable,
  // onboardingCompletedAt nullable, onboard bool default false, platformRole
  // CHECK default 'user', accountType CHECK default 'seller', phone nullable,
  // socialLinks jsonb default {}, websiteUrl nullable, mlsId nullable,
  // companyAffiliation nullable, preferredNotification CHECK default 'email'
  // nullable, timezone default 'America/New_York' nullable, referralSource
  // nullable, biggestPainPoint nullable, status CHECK default 'active',
  // offboardedAt nullable, offboardedToUserId nullable).
  User: defineTable({
    id: v.string(),
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    avatar: v.optional(v.string()),
    bio: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601 (PG default now())
    onboardingCurrentStep: v.number(), // integer, default 0
    onboardingStartedAt: v.optional(v.string()),
    onboardingCompletedAt: v.optional(v.string()),
    onboard: v.boolean(), // default false
    platformRole: v.union(v.literal('user'), v.literal('admin'), v.literal('banned')),
    accountType: v.union(v.literal('seller'), v.literal('manager_only'), v.literal('both')),
    phone: v.optional(v.string()),
    socialLinks: v.optional(v.any()), // jsonb (default {})
    websiteUrl: v.optional(v.string()),
    mlsId: v.optional(v.string()),
    companyAffiliation: v.optional(v.string()),
    preferredNotification: v.optional(
      v.union(v.literal('email'), v.literal('sms'), v.literal('both')),
    ),
    timezone: v.optional(v.string()),
    referralSource: v.optional(v.string()),
    biggestPainPoint: v.optional(v.string()),
    status: v.union(v.literal('active'), v.literal('offboarded')),
    offboardedAt: v.optional(v.string()),
    offboardedToUserId: v.optional(v.string()),
  })
    // Per-row reads/updates/deletes keyed by id (space owner identity, batch id
    // resolution targets, account export/deletion, onboarding patches).
    .index('by_app_id', ['id'])
    // The dominant lookup: resolve the DB user from the Clerk identity on every
    // auth'd request (User_clerkId_key UNIQUE / idx_user_clerk_id). Also backs
    // the upsertByClerkId uniqueness read.
    .index('by_clerk_id', ['clerkId'])
    // Invite-dedup: "does a User already exist for this email?" (.eq('email')).
    .index('by_email', ['email']),

  // Was: "Company" (TEXT id, name, ownerId UNIQUE, status CHECK default 'active',
  // websiteUrl/logoUrl/joinCode[UNIQUE] nullable, 5 jsonb form/scoring configs
  // nullable, createdAt, privacyPolicyHtml/officeAddress/officePhone/agentCount/
  // companyType[CHECK]/primaryMarket[CHECK]/commissionStructure[CHECK]/
  // geographicCoverage nullable, defaultAgentRate numeric default 2.5,
  // defaultManagerRate numeric default 0.5, plan CHECK default 'starter',
  // seatLimit int nullable, stripeCustomerId nullable, stripeSubscriptionId
  // nullable[UNIQUE when not null], stripeSubscriptionStatus CHECK default
  // 'inactive', stripePeriodEnd nullable, autoAssignEnabled bool default false,
  // assignmentMethod CHECK default 'manual', lastAssignedUserId nullable,
  // companyLicenseNumber/companyFairHousingNotice nullable,
  // companyShowEqualHousingMark bool default false, leadRoutingRule CHECK default
  // 'manual', slaEnabled bool default false, slaFirstResponseMinutes int default
  // 60, slaEscalateMinutes int default 120, planActivatedAt nullable).
  // numeric rate columns are NOT money cents — kept numeric per PG.
  Company: defineTable({
    id: v.string(),
    name: v.string(),
    ownerId: v.string(),
    status: v.union(v.literal('active'), v.literal('suspended')),
    websiteUrl: v.optional(v.string()),
    logoUrl: v.optional(v.string()),
    joinCode: v.optional(v.string()),
    companyFormConfig: v.optional(v.any()), // jsonb
    companyRentalFormConfig: v.optional(v.any()), // jsonb
    companyBuyerFormConfig: v.optional(v.any()), // jsonb
    companyRentalScoringModel: v.optional(v.any()), // jsonb
    companyBuyerScoringModel: v.optional(v.any()), // jsonb
    createdAt: v.string(), // ISO-8601
    privacyPolicyHtml: v.optional(v.string()),
    officeAddress: v.optional(v.string()),
    officePhone: v.optional(v.string()),
    agentCount: v.optional(v.string()),
    companyType: v.optional(
      v.union(v.literal('independent'), v.literal('franchise'), v.literal('virtual')),
    ),
    primaryMarket: v.optional(
      v.union(
        v.literal('residential_rental'),
        v.literal('commercial'),
        v.literal('mixed'),
      ),
    ),
    commissionStructure: v.optional(
      v.union(v.literal('flat_fee'), v.literal('percentage_split'), v.literal('hybrid')),
    ),
    geographicCoverage: v.optional(v.string()),
    defaultAgentRate: v.number(), // numeric(5,2) default 2.5
    defaultManagerRate: v.number(), // numeric(5,2) default 0.5
    plan: v.union(
      v.literal('starter'),
      v.literal('team'),
      v.literal('team_plus'),
      v.literal('enterprise'),
    ),
    seatLimit: v.optional(v.number()), // integer
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    stripeSubscriptionStatus: v.union(
      v.literal('active'),
      v.literal('trialing'),
      v.literal('past_due'),
      v.literal('canceled'),
      v.literal('unpaid'),
      v.literal('inactive'),
    ),
    stripePeriodEnd: v.optional(v.string()),
    autoAssignEnabled: v.boolean(), // default false
    assignmentMethod: v.union(
      v.literal('manual'),
      v.literal('round_robin'),
      v.literal('score_based'),
    ),
    lastAssignedUserId: v.optional(v.string()),
    companyLicenseNumber: v.optional(v.string()),
    companyFairHousingNotice: v.optional(v.string()),
    companyShowEqualHousingMark: v.boolean(), // default false
    leadRoutingRule: v.union(
      v.literal('manual'),
      v.literal('round_robin'),
      v.literal('fewest_active'),
    ),
    slaEnabled: v.boolean(), // default false
    slaFirstResponseMinutes: v.number(), // integer default 60
    slaEscalateMinutes: v.number(), // integer default 120
    planActivatedAt: v.optional(v.string()),
  })
    // Per-row reads/updates/deletes keyed by id (settings, billing, webhook,
    // permissions, apply pages, admin toggle/delete).
    .index('by_app_id', ['id'])
    // "Does this user already own a company?" pre-check on create + owner
    // resolution (idx_company_owner UNIQUE(ownerId)).
    .index('by_owner', ['ownerId'])
    // Join-code resolution (join page + /api/manager/join) and collision check on
    // regenerate (Company_joinCode_key / idx_company_join_code UNIQUE).
    .index('by_join_code', ['joinCode'])
    // Stripe webhook reconciliation by subscription id
    // (uq_company_stripe_subscription UNIQUE WHERE NOT NULL).
    .index('by_stripe_subscription', ['stripeSubscriptionId'])
    // (PG's idx_company_stripe_customer is intentionally NOT translated: no call
    // site filters Company by stripeCustomerId — the webhook reads that column on
    // an id-keyed row. A dead index earns nothing.)
    // Admin metrics + cron "active companies" enumeration (.eq('status','active'),
    // idx_company_status).
    .index('by_status', ['status']),

  // Was: "CompanyMembership" (TEXT id, companyId, userId, role CHECK
  // [manager_owner|manager_admin|seller_member], invitedById nullable, createdAt,
  // displayName/title/bio/photoUrl/phone nullable). UNIQUE(companyId, userId).
  CompanyMembership: defineTable({
    id: v.string(),
    companyId: v.string(),
    userId: v.string(),
    role: v.union(
      v.literal('manager_owner'),
      v.literal('manager_admin'),
      v.literal('seller_member'),
    ),
    invitedById: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    displayName: v.optional(v.string()),
    title: v.optional(v.string()),
    bio: v.optional(v.string()),
    photoUrl: v.optional(v.string()),
    phone: v.optional(v.string()),
  })
    // Per-row reads/role-update/delete keyed by id (the [id] member routes,
    // admin membership delete, manager self-profile patch by membership id).
    .index('by_app_id', ['id'])
    // "All of this user's memberships" — auth/permissions resolution of manager
    // context, ordered by createdAt asc (idx_membership_user). Role filters are
    // applied in-handler over this small per-user set.
    .index('by_user', ['userId'])
    // "All members of this company" — member lists, stats rollups, seat counts,
    // seller_member enumeration for routing/leaderboard/publish (idx_membership_
    // company). Role filters applied in-handler.
    .index('by_company', ['companyId'])
    // The (companyId, userId) UNIQUE pair: every "already a member?" idempotency
    // check, scoped membership fetch, and the insert's uniqueness backstop
    // (CompanyMembership_companyId_userId_key).
    .index('by_company_user', ['companyId', 'userId']),

  // Was: "CompanyTemplate" (TEXT id, companyId, name, category CHECK
  // [follow-up|intro|closing|demo-invite], channel CHECK [sms|email|note],
  // subject nullable, body, version int default 1, publishedAt nullable,
  // publishedCount int default 0, createdByUserId nullable, createdAt, updatedAt,
  // publishedVersion int nullable).
  CompanyTemplate: defineTable({
    id: v.string(),
    companyId: v.string(),
    name: v.string(),
    category: v.union(
      v.literal('follow-up'),
      v.literal('intro'),
      v.literal('closing'),
      v.literal('demo-invite'),
    ),
    channel: v.union(v.literal('sms'), v.literal('email'), v.literal('note')),
    subject: v.optional(v.string()),
    body: v.string(),
    version: v.number(), // integer default 1
    publishedAt: v.optional(v.string()),
    publishedCount: v.number(), // integer default 0
    createdByUserId: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    publishedVersion: v.optional(v.number()), // integer
  })
    // PATCH / DELETE / publish-stamp load the template by id (scoped to companyId
    // in the handler).
    .index('by_app_id', ['id'])
    // The library list orders a company's templates by updatedAt DESC
    // (idx_company_template_company_updated = (companyId, updatedAt DESC)).
    .index('by_company_updated', ['companyId', 'updatedAt']),

  // Was: "CompanyRemoval" (companyId, userId, removedAt default now(),
  // removedById nullable, reason nullable). PRIMARY KEY(companyId, userId) — the
  // removal deny-list. No surrogate `id`; the (companyId, userId) pair is the
  // identity, so there is no by_app_id index.
  CompanyRemoval: defineTable({
    companyId: v.string(),
    userId: v.string(),
    removedAt: v.string(), // ISO-8601 (PG default now())
    removedById: v.optional(v.string()),
    reason: v.optional(v.string()),
  })
    // The join-code path checks "was this user removed from this company?"
    // (.eq('companyId').eq('userId')) and the removal upsert reads this same
    // pair before insert (ON CONFLICT(companyId,userId) DO NOTHING).
    // (PG's idx_company_removal_user (by userId alone) is NOT translated: no call
    // site queries CompanyRemoval by userId only.)
    .index('by_company_user', ['companyId', 'userId']),

  // Was: "Invitation" (TEXT id, companyId, email, roleToAssign CHECK
  // [manager_admin|seller_member], token UNIQUE [default random hex], status
  // CHECK [pending|accepted|expired|cancelled] default 'pending', expiresAt
  // default now()+7d, invitedById nullable, createdAt).
  Invitation: defineTable({
    id: v.string(),
    companyId: v.string(),
    email: v.string(),
    roleToAssign: v.union(v.literal('manager_admin'), v.literal('seller_member')),
    token: v.string(),
    status: v.union(
      v.literal('pending'),
      v.literal('accepted'),
      v.literal('expired'),
      v.literal('cancelled'),
    ),
    expiresAt: v.string(), // ISO-8601 (PG default now() + 7 days)
    invitedById: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // Accept/expire/cancel/admin-update flip status by id (scoped to companyId in
    // the manager route).
    .index('by_app_id', ['id'])
    // The public invite page + accept API resolve by token (Invitation_token_key
    // / idx_invitation_token UNIQUE).
    .index('by_token', ['token'])
    // A company's invitation list / pending counts (manager dashboards, admin
    // detail, seat usage), ordered by createdAt DESC in-handler
    // (idx_invitation_company; status filter applied over the per-company set).
    .index('by_company', ['companyId'])
    // The pending-per-email uniqueness (uq_invitation_pending_email UNIQUE
    // (companyId, lower(email)) WHERE status='pending'): the invite paths
    // pre-check (companyId, email, status='pending') before insert. We store the
    // email as given (callers trim; this lowercases on read for the dedup).
    .index('by_company_email_status', ['companyId', 'email', 'status'])
    // "Invites waiting for me" by email — the auth-redirect pending lookup and
    // the seller settings list (.eq('email')/.ilike('email'), idx_invitation_
    // email). Case-insensitive matches are resolved in-handler.
    .index('by_email', ['email']),
};
