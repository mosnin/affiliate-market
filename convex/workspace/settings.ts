import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * SpaceSetting data access — the Convex replacement for every `.from('SpaceSetting')`
 * read & write. SpaceSetting is one-row-per-space (UNIQUE(spaceId)); the ~60
 * call sites all read by spaceId (each naming a different column subset) or
 * upsert-on-spaceId (merging a few fields). We collapse that to:
 *   - getBySpace(spaceId)         → the full row (callers pick their columns).
 *   - getByUnsubscribeToken(token)→ the brief-unsubscribe resolve (UNIQUE token).
 *   - listBriefEnabled / listForBriefAnalytics / listReferencedMedia /
 *     listBusinessNamesForSpaces → the handful of cross-row scans the crons do.
 *   - upsertBySpace(spaceId, fields) → the merge upsert (onConflict 'spaceId'),
 *     read-then-insert-or-patch in ONE serializable mutation (replaces every
 *     partial .upsert/.update over the row, including the giant settings PATCH).
 *   - setBriefEmailById(id, value)→ the only PATCH keyed on `id` (unsubscribe).
 *
 * One-per-space invariant: PG's UNIQUE(spaceId) is preserved by the upsert always
 * reading the existing row by_space before deciding insert vs patch — a concurrent
 * first-write can't create two rows. The incoming `id` some call sites synthesised
 * is ignored; we mint one only on insert.
 *
 * The PG row has DEFAULTs on the NOT-NULL columns (notifications true, timezone
 * 'America/New_York', demoDuration 30, formConfigSource 'legacy', etc.). On INSERT
 * we apply those same defaults so a fresh row matches what Postgres would have
 * produced; callers' `?? default` fallbacks then still hold for the optionals.
 */

type SettingFields = Doc<'SpaceSetting'>;

/** Surface the full SpaceSetting row with `id`, coercing absent optionals to
 *  SQL NULL (the legacy `SpaceSetting` Row shape in lib/types.ts). Array/jsonb
 *  columns keep their stored value; absent stays null for the lib `?? default`. */
function toRow(s: SettingFields) {
  return {
    id: s.id,
    spaceId: s.spaceId,
    notifications: s.notifications,
    smsNotifications: s.smsNotifications,
    notifyNewLeads: s.notifyNewLeads,
    notifyDemoBookings: s.notifyDemoBookings,
    notifyNewDeals: s.notifyNewDeals,
    notifyFollowUps: s.notifyFollowUps,
    notifyPush: s.notifyPush,
    timezone: s.timezone,
    phoneNumber: s.phoneNumber ?? null,
    myConnections: s.myConnections ?? null,
    aiPersonalization: s.aiPersonalization ?? null,
    billingSettings: s.billingSettings ?? null,
    businessName: s.businessName ?? null,
    intakePageTitle: s.intakePageTitle ?? null,
    intakePageIntro: s.intakePageIntro ?? null,
    bio: s.bio ?? null,
    socialLinks: s.socialLinks ?? null,
    intakeAccentColor: s.intakeAccentColor ?? null,
    intakeBorderRadius: s.intakeBorderRadius ?? null,
    intakeFont: s.intakeFont ?? null,
    intakeFooterLinks: s.intakeFooterLinks ?? null,
    intakeHeaderBgColor: s.intakeHeaderBgColor ?? null,
    intakeHeaderGradient: s.intakeHeaderGradient ?? null,
    intakeDarkMode: s.intakeDarkMode,
    intakeFaviconUrl: s.intakeFaviconUrl ?? null,
    demoDuration: s.demoDuration,
    demoStartHour: s.demoStartHour,
    demoEndHour: s.demoEndHour,
    demoDaysAvailable: s.demoDaysAvailable,
    demoBookingPageTitle: s.demoBookingPageTitle ?? null,
    demoBookingPageIntro: s.demoBookingPageIntro ?? null,
    demoBufferMinutes: s.demoBufferMinutes,
    demoBlockedDates: s.demoBlockedDates,
    privacyPolicyUrl: s.privacyPolicyUrl ?? null,
    consentCheckboxLabel: s.consentCheckboxLabel ?? null,
    privacyPolicyHtml: s.privacyPolicyHtml ?? null,
    formConfig: s.formConfig ?? null,
    rentalFormConfig: s.rentalFormConfig ?? null,
    buyerFormConfig: s.buyerFormConfig ?? null,
    formConfigSource: s.formConfigSource,
    rentalScoringModel: s.rentalScoringModel ?? null,
    buyerScoringModel: s.buyerScoringModel ?? null,
    trackingPixels: s.trackingPixels ?? null,
    isVerified: s.isVerified,
    logoUrl: s.logoUrl ?? null,
    sellerPhotoUrl: s.sellerPhotoUrl ?? null,
    intakeThankYouTitle: s.intakeThankYouTitle ?? null,
    intakeThankYouMessage: s.intakeThankYouMessage ?? null,
    intakeConfirmationEmail: s.intakeConfirmationEmail ?? null,
    intakeVideoUrl: s.intakeVideoUrl ?? null,
    intakeDisclaimerText: s.intakeDisclaimerText ?? null,
    intakeDisabledSteps: s.intakeDisabledSteps ?? null,
    intakeRequiredFields: s.intakeRequiredFields ?? null,
    intakeCustomQuestions: s.intakeCustomQuestions ?? null,
    intakeStepOrder: s.intakeStepOrder ?? null,
    intakeLicenseNumber: s.intakeLicenseNumber ?? null,
    intakeFairHousingNotice: s.intakeFairHousingNotice ?? null,
    intakeShowEqualHousingMark: s.intakeShowEqualHousingMark,
    briefEnabled: s.briefEnabled,
    briefHour: s.briefHour,
    briefIntroSeenAt: s.briefIntroSeenAt ?? null,
    briefEnabledAt: s.briefEnabledAt ?? null,
    briefEmail: s.briefEmail,
    briefSms: s.briefSms,
    unsubscribeToken: s.unsubscribeToken ?? null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The settings row for a space (full row), or null. Mirrors every
 *  `.eq('spaceId', spaceId).maybeSingle()` — the caller reads whichever columns it
 *  named; absent row → null and the lib applies its own defaults. */
export const getBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('SpaceSetting')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .first();
    return s ? toRow(s) : null;
  },
});

/** The settings row carrying a given unsubscribe token, or null. Mirrors
 *  brief/unsubscribe's `.eq('unsubscribeToken', token).maybeSingle()` (the only
 *  non-spaceId read). UNIQUE(unsubscribeToken). */
export const getByUnsubscribeToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query('SpaceSetting')
      .withIndex('by_unsubscribe_token', (q) => q.eq('unsubscribeToken', args.token))
      .first();
    return s ? toRow(s) : null;
  },
});

/** Rows with briefEnabled=true, capped. Mirrors cron/daily-briefing's
 *  `.eq('briefEnabled', true).limit(MAX_PER_TICK)` (it reads spaceId/timezone/
 *  briefEnabled/briefHour off the full row). */
export const listBriefEnabled = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query('SpaceSetting').collect();
    return rows
      .filter((s) => s.briefEnabled === true)
      .slice(0, args.limit)
      .map(toRow);
  },
});

/** Every row's (spaceId, briefEnabled, briefEnabledAt) for the brief-analytics
 *  cohort report. Mirrors `.select('spaceId, briefEnabled, briefEnabledAt,
 *  Space:spaceId(stripeSubscriptionStatus)')` — the Space join STAYS IN LIB
 *  (cross-domain); this returns the SpaceSetting columns and the lib hops Space. */
export const listForBriefAnalytics = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('SpaceSetting').collect();
    return rows.map((s) => ({
      spaceId: s.spaceId,
      briefEnabled: s.briefEnabled,
      briefEnabledAt: s.briefEnabledAt ?? null,
    }));
  },
});

/** Every row's media keys (logoUrl/sellerPhotoUrl/intakeFaviconUrl), capped. The
 *  storage-gc "do not delete" guard. Mirrors `.select('logoUrl, sellerPhotoUrl,
 *  intakeFaviconUrl').limit(5000)`. */
export const listReferencedMedia = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query('SpaceSetting').collect();
    return rows.slice(0, args.limit ?? 5000).map((s) => ({
      logoUrl: s.logoUrl ?? null,
      sellerPhotoUrl: s.sellerPhotoUrl ?? null,
      intakeFaviconUrl: s.intakeFaviconUrl ?? null,
    }));
  },
});

/** (spaceId, businessName) for a set of spaces. Mirrors demos/reminders'
 *  `.select('spaceId, businessName').in('spaceId', spaceIds)`. */
export const listBusinessNamesForSpaces = query({
  args: { spaceIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.spaceIds.length === 0) return [];
    const wanted = new Set(args.spaceIds);
    const out: { spaceId: string; businessName: string | null }[] = [];
    for (const spaceId of wanted) {
      const s = await ctx.db
        .query('SpaceSetting')
        .withIndex('by_space', (q) => q.eq('spaceId', spaceId))
        .first();
      if (s) out.push({ spaceId: s.spaceId, businessName: s.businessName ?? null });
    }
    return out;
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * The writable SpaceSetting columns any caller can set via the merge upsert. All
 * optional — only provided keys change. Tri-state columns accept `null` to clear
 * (the routes pass null to wipe an optional like privacyPolicyHtml). NOT-NULL
 * flag/number/enum columns take their concrete type (never null). `id`/`spaceId`/
 * `createdAt` are NOT writable here (id is minted on insert; spaceId is the key).
 */
const writableFields = {
  notifications: v.optional(v.boolean()),
  smsNotifications: v.optional(v.boolean()),
  notifyNewLeads: v.optional(v.boolean()),
  notifyDemoBookings: v.optional(v.boolean()),
  notifyNewDeals: v.optional(v.boolean()),
  notifyFollowUps: v.optional(v.boolean()),
  notifyPush: v.optional(v.boolean()),
  timezone: v.optional(v.string()),
  phoneNumber: v.optional(v.union(v.string(), v.null())),
  myConnections: v.optional(v.union(v.string(), v.null())),
  aiPersonalization: v.optional(v.union(v.string(), v.null())),
  billingSettings: v.optional(v.union(v.string(), v.null())),
  businessName: v.optional(v.union(v.string(), v.null())),
  intakePageTitle: v.optional(v.union(v.string(), v.null())),
  intakePageIntro: v.optional(v.union(v.string(), v.null())),
  bio: v.optional(v.union(v.string(), v.null())),
  socialLinks: v.optional(v.any()),
  intakeAccentColor: v.optional(v.union(v.string(), v.null())),
  intakeBorderRadius: v.optional(v.union(v.literal('rounded'), v.literal('sharp'))),
  intakeFont: v.optional(v.union(v.literal('system'), v.literal('serif'), v.literal('mono'))),
  intakeFooterLinks: v.optional(v.any()),
  intakeHeaderBgColor: v.optional(v.union(v.string(), v.null())),
  intakeHeaderGradient: v.optional(v.union(v.string(), v.null())),
  intakeDarkMode: v.optional(v.boolean()),
  intakeFaviconUrl: v.optional(v.union(v.string(), v.null())),
  demoDuration: v.optional(v.number()),
  demoStartHour: v.optional(v.number()),
  demoEndHour: v.optional(v.number()),
  demoDaysAvailable: v.optional(v.array(v.number())),
  demoBookingPageTitle: v.optional(v.union(v.string(), v.null())),
  demoBookingPageIntro: v.optional(v.union(v.string(), v.null())),
  demoBufferMinutes: v.optional(v.number()),
  demoBlockedDates: v.optional(v.array(v.string())),
  privacyPolicyUrl: v.optional(v.union(v.string(), v.null())),
  consentCheckboxLabel: v.optional(v.union(v.string(), v.null())),
  privacyPolicyHtml: v.optional(v.union(v.string(), v.null())),
  formConfig: v.optional(v.any()),
  rentalFormConfig: v.optional(v.any()),
  buyerFormConfig: v.optional(v.any()),
  formConfigSource: v.optional(
    v.union(v.literal('custom'), v.literal('company'), v.literal('legacy')),
  ),
  rentalScoringModel: v.optional(v.any()),
  buyerScoringModel: v.optional(v.any()),
  trackingPixels: v.optional(v.any()),
  isVerified: v.optional(v.boolean()),
  logoUrl: v.optional(v.union(v.string(), v.null())),
  sellerPhotoUrl: v.optional(v.union(v.string(), v.null())),
  intakeThankYouTitle: v.optional(v.union(v.string(), v.null())),
  intakeThankYouMessage: v.optional(v.union(v.string(), v.null())),
  intakeConfirmationEmail: v.optional(v.union(v.string(), v.null())),
  intakeVideoUrl: v.optional(v.union(v.string(), v.null())),
  intakeDisclaimerText: v.optional(v.union(v.string(), v.null())),
  intakeDisabledSteps: v.optional(v.array(v.string())),
  intakeRequiredFields: v.optional(v.array(v.string())),
  intakeCustomQuestions: v.optional(v.any()),
  intakeStepOrder: v.optional(v.array(v.string())),
  intakeLicenseNumber: v.optional(v.union(v.string(), v.null())),
  intakeFairHousingNotice: v.optional(v.union(v.string(), v.null())),
  intakeShowEqualHousingMark: v.optional(v.boolean()),
  briefEnabled: v.optional(v.boolean()),
  briefHour: v.optional(v.number()),
  briefIntroSeenAt: v.optional(v.union(v.string(), v.null())),
  briefEnabledAt: v.optional(v.union(v.string(), v.null())),
  briefEmail: v.optional(v.boolean()),
  briefSms: v.optional(v.boolean()),
};

// PG column DEFAULTs for the NOT-NULL columns — applied on INSERT so a freshly
// created row matches what Postgres would have written.
const NOT_NULL_DEFAULTS = {
  notifications: true,
  smsNotifications: false,
  notifyNewLeads: true,
  notifyDemoBookings: true,
  notifyNewDeals: true,
  notifyFollowUps: true,
  notifyPush: true,
  timezone: 'America/New_York',
  intakeDarkMode: false,
  demoDuration: 30,
  demoStartHour: 9,
  demoEndHour: 17,
  demoDaysAvailable: [1, 2, 3, 4, 5],
  demoBufferMinutes: 0,
  demoBlockedDates: [] as string[],
  formConfigSource: 'legacy' as const,
  isVerified: false,
  intakeShowEqualHousingMark: false,
  briefEnabled: true,
  briefHour: 7,
  briefEmail: false,
  briefSms: false,
} as const;

// Optional PG columns whose DEFAULT is a non-null literal (so a fresh row gets it
// even though the column is nullable). Applied on INSERT only.
const OPTIONAL_DEFAULTS: Record<string, unknown> = {
  intakeAccentColor: '#ff964f',
  intakeBorderRadius: 'rounded',
  intakeFont: 'system',
  socialLinks: {},
  intakeFooterLinks: [],
  intakeCustomQuestions: [],
  intakeDisabledSteps: [],
  intakeRequiredFields: [],
  intakeStepOrder: [],
};

/**
 * Upsert the space's settings row (PG `.upsert(payload, { onConflict: 'spaceId' })`).
 * INSERT path: start from PG defaults, then apply the provided fields. PATCH path:
 * change only provided keys; a provided `null` clears the optional column (sets it
 * absent == SQL NULL); a NOT-NULL column ignores null. Returns the full row (the
 * `.select()` the routes hand back). Race-safe: the existing-row read + write are
 * one serializable mutation, preserving UNIQUE(spaceId).
 *
 * `unsubscribeToken` is NOT writable through this path (PG defaults it once via
 * gen_random_bytes; the app never sets it). On a brand-new row we mint one so the
 * unsubscribe link works, matching PG's column default.
 */
export const upsertBySpace = mutation({
  args: { spaceId: v.string(), fields: v.object(writableFields) },
  handler: async (ctx, args) => {
    const f = args.fields as Record<string, unknown>;

    const existing = await ctx.db
      .query('SpaceSetting')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .first();

    if (!existing) {
      // INSERT — PG defaults first, then provided values override.
      const doc: Record<string, unknown> = {
        id: crypto.randomUUID(),
        spaceId: args.spaceId,
        unsubscribeToken: randomToken(),
        ...NOT_NULL_DEFAULTS,
      };
      for (const [k, v0] of Object.entries(OPTIONAL_DEFAULTS)) doc[k] = v0;
      for (const [k, val] of Object.entries(f)) {
        if (val === undefined) continue;
        // null on insert means "leave unset" (SQL NULL) — but only for columns
        // that don't have a NOT-NULL default we just applied.
        if (val === null) {
          if (!(k in NOT_NULL_DEFAULTS)) delete doc[k];
          continue;
        }
        doc[k] = val;
      }
      await ctx.db.insert('SpaceSetting', doc as unknown as SettingFields);
      const stored = await ctx.db
        .query('SpaceSetting')
        .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
        .first();
      return toRow(stored!);
    }

    // PATCH — only provided keys change; null clears nullable columns.
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(f)) {
      if (val === undefined) continue;
      if (val === null) {
        // NOT-NULL columns can't be nulled — ignore (the code never does it).
        if (k in NOT_NULL_DEFAULTS) continue;
        patch[k] = undefined; // clear the optional column
        continue;
      }
      patch[k] = val;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
    return toRow((await ctx.db.get(existing._id))!);
  },
});

/** Flip briefEmail off (or on) on a settings row found by its id — the
 *  unsubscribe link's `.update({ briefEmail: false }).eq('id', setting.id)`.
 *  (Kept as the only id-keyed write; everything else keys on spaceId.) */
export const setBriefEmailById = mutation({
  args: { id: v.string(), briefEmail: v.boolean() },
  handler: async (ctx, args): Promise<void> => {
    const s = await ctx.db
      .query('SpaceSetting')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!s) return;
    await ctx.db.patch(s._id, { briefEmail: args.briefEmail });
  },
});

/** 32-hex-char token, mirroring PG's `encode(gen_random_bytes(16), 'hex')` default
 *  for unsubscribeToken (minted only when we create a fresh settings row). */
function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
