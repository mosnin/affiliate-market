import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Workspace domain tables — the platform core. A Space is a seller's workspace
 * (the `/s/[slug]` surface); SpaceSetting is its one-row settings sheet;
 * DisabledSpace is the agent kill-switch ledger. Almost every other table FKs to
 * Space.id, so these shapes are load-bearing for the whole product.
 *
 * See convex/CONVENTIONS.md for the Postgres -> Convex translation rules every
 * table here follows (string `id`; ISO-8601 timestamps as v.string(); CHECK
 * enums -> v.union of v.literal; nullable -> v.optional; jsonb -> v.any; integer
 * counts -> v.number; bool -> v.boolean; text[]/integer[] -> v.array).
 *
 * Postgres uniqueness invariants that encode real business behavior (no native
 * Convex equivalent) are re-implemented as read-then-insert/patch inside the
 * mutations (serializable within one mutation), noted per table:
 *   - Space.ownerId is UNIQUE in practice (one producing Space per user) — the
 *     code relies on getSpaceByOwnerId returning at most one. by_owner backs both
 *     the read and the create-time "does this owner already have a space" guard.
 *   - SpaceSetting_spaceId_key UNIQUE(spaceId): exactly one settings row per
 *     space. Every write is an upsert-on-spaceId, re-implemented as
 *     read-by-space-then-insert-or-patch (convex/workspace/settings.ts).
 *   - SpaceSetting_unsubscribeToken_key UNIQUE(unsubscribeToken): the brief
 *     unsubscribe link resolves a row by this token (by_unsubscribe_token).
 *   - DisabledSpace_spaceId_active_idx UNIQUE(spaceId) WHERE isActive=true: at
 *     most one *active* disable per space. The disable mutation preserves it by
 *     read-active-then-patch-or-insert (convex/workspace/disabled.ts).
 *
 * Postgres ON DELETE CASCADE (SpaceSetting/DisabledSpace -> Space, plus ~30 other
 * tables) fires when a Space is deleted. Cross-domain cascades cannot run from a
 * Convex mutation in phase 1 (those tables live in other domains / still on
 * Supabase); the Space DELETE path in lib remains responsible for them. Within
 * THIS domain we cascade SpaceSetting + DisabledSpace explicitly in removeSpace.
 */
export const workspaceTables = {
  // Was: "Space" (TEXT id [app-supplied, not gen_random], slug, name, emoji
  // default '🏠', createdAt default now(), ownerId, companyId nullable,
  // stripeCustomerId nullable, stripeSubscriptionId nullable,
  // stripeSubscriptionStatus default 'inactive', stripePeriodEnd nullable,
  // trialUsedAt nullable, stripeConnectAccountId nullable, marketplaceFeeBps
  // integer nullable, plan default 'free', planActivatedAt nullable).
  //
  // stripeSubscriptionStatus has no DB CHECK — it holds the app's
  // SubscriptionStatus values ('inactive'|'trialing'|'active'|'past_due'|
  // 'canceled'|'unpaid'|'incomplete'|...). Kept as a free v.string() to match the
  // un-constrained column rather than risk an enum that rejects a Stripe status.
  Space: defineTable({
    id: v.string(),
    slug: v.string(),
    name: v.string(),
    emoji: v.string(), // default '🏠' applied by the writer
    createdAt: v.string(), // ISO-8601 (was TIMESTAMPTZ default now())
    ownerId: v.string(),
    companyId: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    stripeSubscriptionStatus: v.string(), // default 'inactive'
    stripePeriodEnd: v.optional(v.string()), // ISO-8601
    trialUsedAt: v.optional(v.string()), // ISO-8601
    stripeConnectAccountId: v.optional(v.string()),
    marketplaceFeeBps: v.optional(v.number()), // integer basis points (NOT cents)
    plan: v.string(), // default 'free'
    planActivatedAt: v.optional(v.string()), // ISO-8601
  })
    // getSpaceById + the dozens of `.eq('id', spaceId)` reads/updates (webhooks,
    // billing, AI tasks, settings) key by the string id.
    .index('by_app_id', ['id'])
    // getSpaceFromSlug + every slug lookup/update/delete (Space PK is the slug for
    // the public workspace URL). UNIQUE(slug) in the app.
    .index('by_slug', ['slug'])
    // getSpaceByOwnerId / getSpaceForUser / onboarding / manager — ownerId is the
    // unique "this user's producing space" key. Also backs admin/broadcast and the
    // `.in('ownerId', userIds)` company-member fan-outs (scanned in mem per id).
    .index('by_owner', ['ownerId'])
    // Company-pool listings + manager surfaces filter by companyId
    // (.eq('companyId', id) and the admin un-link sets it null).
    .index('by_company', ['companyId'])
    // Stripe webhook reconciliation: subscription.updated/deleted and
    // invoice.* look the space up by its subscription id when the metadata
    // spaceId is absent (legacy path).
    .index('by_stripe_subscription', ['stripeSubscriptionId']),

  // Was: "SpaceSetting" — the one-row-per-space settings sheet. ~80 columns:
  // notification flags (bool), brief settings, intake/branding copy + colors,
  // demo availability (integers + integer[]/text[] arrays), jsonb form configs &
  // scoring models, tracking pixels. UNIQUE(spaceId) — exactly one per space.
  //
  // Enums with PG CHECKs kept as v.union of v.literal:
  //   intakeBorderRadius ∈ {'rounded','sharp'} (nullable, default 'rounded')
  //   intakeFont         ∈ {'system','serif','mono'} (nullable, default 'system')
  //   formConfigSource   ∈ {'custom','company','legacy'} (NOT NULL, default 'legacy')
  // (briefHour 0..23 is a CHECK *range*, not an enum — kept v.number, validated in lib.)
  //
  // billingSettings / aiPersonalization / myConnections are PG `text` (the app
  // JSON-encodes into them) -> v.optional(v.string()). socialLinks /
  // intakeFooterLinks / intakeCustomQuestions / formConfig / rentalFormConfig /
  // buyerFormConfig / rentalScoringModel / buyerScoringModel / trackingPixels are
  // real jsonb -> v.any(). text[]/integer[] columns -> v.array(...).
  SpaceSetting: defineTable({
    id: v.string(),
    spaceId: v.string(),
    // Notification flags
    notifications: v.boolean(), // default true
    smsNotifications: v.boolean(), // default false
    notifyNewLeads: v.boolean(), // default true
    notifyDemoBookings: v.boolean(), // default true
    notifyNewDeals: v.boolean(), // default true
    notifyFollowUps: v.boolean(), // default true
    notifyPush: v.boolean(), // default true
    timezone: v.string(), // default 'America/New_York'
    phoneNumber: v.optional(v.string()),
    myConnections: v.optional(v.string()), // text (JSON-encoded by app)
    aiPersonalization: v.optional(v.string()), // text
    billingSettings: v.optional(v.string()), // text (JSON-encoded by app)
    businessName: v.optional(v.string()),
    // Intake page content
    intakePageTitle: v.optional(v.string()),
    intakePageIntro: v.optional(v.string()),
    bio: v.optional(v.string()),
    socialLinks: v.optional(v.any()), // jsonb default '{}'
    // Appearance
    intakeAccentColor: v.optional(v.string()), // default '#ff964f'
    intakeBorderRadius: v.optional(v.union(v.literal('rounded'), v.literal('sharp'))), // default 'rounded'
    intakeFont: v.optional(v.union(v.literal('system'), v.literal('serif'), v.literal('mono'))), // default 'system'
    intakeFooterLinks: v.optional(v.any()), // jsonb default '[]'
    intakeHeaderBgColor: v.optional(v.string()),
    intakeHeaderGradient: v.optional(v.string()),
    intakeDarkMode: v.boolean(), // default false
    intakeFaviconUrl: v.optional(v.string()),
    // Demo availability
    demoDuration: v.number(), // integer, default 30
    demoStartHour: v.number(), // integer, default 9
    demoEndHour: v.number(), // integer, default 17
    demoDaysAvailable: v.array(v.number()), // integer[], default {1,2,3,4,5}
    demoBookingPageTitle: v.optional(v.string()),
    demoBookingPageIntro: v.optional(v.string()),
    demoBufferMinutes: v.number(), // integer, default 0
    demoBlockedDates: v.array(v.string()), // text[], default {}
    // Legal & compliance
    privacyPolicyUrl: v.optional(v.string()),
    consentCheckboxLabel: v.optional(v.string()),
    privacyPolicyHtml: v.optional(v.string()),
    // Dynamic form builder (jsonb)
    formConfig: v.optional(v.any()),
    rentalFormConfig: v.optional(v.any()),
    buyerFormConfig: v.optional(v.any()),
    formConfigSource: v.union(v.literal('custom'), v.literal('company'), v.literal('legacy')), // default 'legacy'
    rentalScoringModel: v.optional(v.any()), // jsonb
    buyerScoringModel: v.optional(v.any()), // jsonb
    trackingPixels: v.optional(v.any()), // jsonb
    // Verification / media
    isVerified: v.boolean(), // default false
    logoUrl: v.optional(v.string()),
    sellerPhotoUrl: v.optional(v.string()),
    // Intake content extras
    intakeThankYouTitle: v.optional(v.string()),
    intakeThankYouMessage: v.optional(v.string()),
    intakeConfirmationEmail: v.optional(v.string()),
    intakeVideoUrl: v.optional(v.string()),
    intakeDisclaimerText: v.optional(v.string()),
    // Form field control (arrays / jsonb)
    intakeDisabledSteps: v.optional(v.array(v.string())), // text[] default {}
    intakeRequiredFields: v.optional(v.array(v.string())), // text[] default {}
    intakeCustomQuestions: v.optional(v.any()), // jsonb default '[]'
    intakeStepOrder: v.optional(v.array(v.string())), // text[] default {}
    intakeLicenseNumber: v.optional(v.string()),
    intakeFairHousingNotice: v.optional(v.string()),
    intakeShowEqualHousingMark: v.boolean(), // default false
    // Daily brief
    briefEnabled: v.boolean(), // default true
    briefHour: v.number(), // integer 0..23 (CHECK range), default 7
    briefIntroSeenAt: v.optional(v.string()), // ISO-8601
    briefEnabledAt: v.optional(v.string()), // ISO-8601
    briefEmail: v.boolean(), // default false
    briefSms: v.boolean(), // default false
    unsubscribeToken: v.optional(v.string()), // default = random hex; UNIQUE
  })
    // Every per-space access keys on spaceId (UNIQUE) — getSpaceSettings + the
    // upsert read-then-write. idx_space_setting_sid.
    .index('by_space', ['spaceId'])
    // The PATCH-by-id path: brief/unsubscribe flips briefEmail with .eq('id').
    .index('by_app_id', ['id'])
    // brief/unsubscribe resolves the row from the emailed token
    // (SpaceSetting_unsubscribeToken_key UNIQUE).
    .index('by_unsubscribe_token', ['unsubscribeToken']),

  // Was: "DisabledSpace" (TEXT id, spaceId, reason, disabledBy default 'system',
  // disabledAt default now(), reenabledAt nullable, isActive default true).
  // The agent kill-switch ledger (lib/agent/kill-switch.ts).
  //
  // UNIQUE(spaceId) WHERE isActive=true: at most one active row per space. The
  // PG upsert used onConflict 'spaceId,isActive'; we preserve "one active per
  // space" by reading the active row first and patching it (or inserting a new
  // active one) inside one serializable mutation.
  DisabledSpace: defineTable({
    id: v.string(),
    spaceId: v.string(),
    reason: v.string(),
    disabledBy: v.string(), // default 'system'
    disabledAt: v.string(), // ISO-8601 (was TIMESTAMPTZ default now())
    reenabledAt: v.optional(v.string()), // ISO-8601
    isActive: v.boolean(), // default true
  })
    // isSpaceDisabled / disable / reenable all filter (spaceId, isActive).
    // DisabledSpace_spaceId_isActive_idx = (spaceId, isActive).
    .index('by_space_active', ['spaceId', 'isActive']),
};
