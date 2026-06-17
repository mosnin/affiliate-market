import { query, mutation, type QueryCtx } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * Contact data access — the Convex replacement for EVERY `.from('Contact')` read &
 * write across the app (~270 call sites: seller People CRUD, manager leads,
 * AI tools, agent routes, cards, the public applicant portal, demos, deals,
 * scoring, admin health, briefings).
 *
 * Contact is a wide, shared row read by many domains that stay on Supabase. Per
 * CONVENTIONS each call site swaps ONLY its Contact hop; the reads here return the
 * FULL mapped Contact row (`toRow`) and the caller projects the columns it used to
 * `.select()` — no behavioral difference, just a wider payload, and the call-site
 * rewrite stays mechanical.
 *
 * Filters PG expressed in SQL that Convex can't push onto an index — tags overlap
 * (`.contains` / `.overlaps`), free-text `.ilike` search, leadType/scoringStatus
 * within a space, date windows, companyId-null — are applied in-handler after an
 * indexed space scan (the marketplace-products `.or(ilike)` precedent). Manager
 * rollups that PG did with `.in('spaceId', [...])` accept `spaceIds: string[]` and
 * loop the `by_space` index per space, unioning in-handler.
 *
 * Money: none. budget/leadScore are double-precision scores, not cents.
 *
 * Cross-domain stays in lib (CONVENTIONS): deleteContact cascades ONLY to this
 * domain's children (ContactActivity, ContactDocument); the DealContact/Deal/
 * Wasabi/vector cleanup the delete ROUTE does is left in lib. merge-persons keeps
 * its DealContact moves + vector reindex in lib and uses moveActivities + delete
 * here for the Contact/ContactActivity hops.
 */

type ContactFields = {
  id: string;
  spaceId: string;
  name: string;
  email?: string;
  phone?: string;
  leadType: 'rental' | 'buyer' | 'seller';
  address?: string;
  notes?: string;
  budget?: number;
  preferences?: string;
  products: string[];
  type: string;
  tags: string[];
  leadScore?: number;
  scoreLabel?: string;
  scoreSummary?: string;
  scoringStatus: 'pending' | 'scored' | 'failed';
  scoreDetails?: unknown;
  applicationData?: unknown;
  followUpAt?: string;
  lastContactedAt?: string;
  sourceLabel?: string;
  companyId?: string;
  stageChangedAt?: string;
  applicationRef?: string;
  applicationStatus?: string;
  applicationStatusNote?: string;
  statusPortalToken?: string;
  consentGiven?: boolean;
  consentTimestamp?: string;
  consentIp?: string;
  consentPrivacyPolicyUrl?: string;
  formConfigSnapshot?: unknown;
  formLeadType?: string;
  createdAt: string;
  updatedAt: string;
  sourceDemoId?: string;
  snoozedUntil?: string;
  referralSource?: string;
};

/**
 * The full legacy Contact row. Surfaces `id`, drops _id/_creationTime, coerces
 * every absent optional back to the SQL NULL `select('*')` rows carried (so any
 * caller projecting a column sees `null`, never `undefined`). products/tags/
 * businessFocus-style arrays default [] (PG array columns are NOT NULL).
 */
function toRow(c: ContactFields) {
  return {
    id: c.id,
    spaceId: c.spaceId,
    name: c.name,
    email: c.email ?? null,
    phone: c.phone ?? null,
    leadType: c.leadType,
    address: c.address ?? null,
    notes: c.notes ?? null,
    budget: c.budget ?? null,
    preferences: c.preferences ?? null,
    products: Array.isArray(c.products) ? c.products : [],
    type: c.type,
    tags: Array.isArray(c.tags) ? c.tags : [],
    leadScore: c.leadScore ?? null,
    scoreLabel: c.scoreLabel ?? null,
    scoreSummary: c.scoreSummary ?? null,
    scoringStatus: c.scoringStatus,
    scoreDetails: c.scoreDetails ?? null,
    applicationData: c.applicationData ?? null,
    followUpAt: c.followUpAt ?? null,
    lastContactedAt: c.lastContactedAt ?? null,
    sourceLabel: c.sourceLabel ?? null,
    companyId: c.companyId ?? null,
    stageChangedAt: c.stageChangedAt ?? null,
    applicationRef: c.applicationRef ?? null,
    applicationStatus: c.applicationStatus ?? null,
    applicationStatusNote: c.applicationStatusNote ?? null,
    statusPortalToken: c.statusPortalToken ?? null,
    consentGiven: c.consentGiven ?? null,
    consentTimestamp: c.consentTimestamp ?? null,
    consentIp: c.consentIp ?? null,
    consentPrivacyPolicyUrl: c.consentPrivacyPolicyUrl ?? null,
    formConfigSnapshot: c.formConfigSnapshot ?? null,
    formLeadType: c.formLeadType ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    sourceDemoId: c.sourceDemoId ?? null,
    snoozedUntil: c.snoozedUntil ?? null,
    referralSource: c.referralSource ?? null,
  };
}

const leadTypeValidator = v.union(v.literal('rental'), v.literal('buyer'), v.literal('seller'));
const scoringStatusValidator = v.union(
  v.literal('pending'),
  v.literal('scored'),
  v.literal('failed'),
);

const descByCreated = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;

/** Does row `c` contain ALL of `needed` tags (PG `.contains('tags', needed)`)? */
function hasAllTags(c: { tags: string[] }, needed: string[]): boolean {
  return needed.every((t) => c.tags.includes(t));
}
/** Does row `c` share ANY tag with `any` (PG `.overlaps('tags', any)`)? */
function overlapsTags(c: { tags: string[] }, any: string[]): boolean {
  return c.tags.some((t) => any.includes(t));
}

// ── Single-row reads ─────────────────────────────────────────────────────────

/** One contact by id, full row, or null. Mirrors `.eq('id').maybeSingle()` and the
 *  `.eq('id').eq('spaceId')` reads (caller still checks spaceId; pass it to scope).
 *  When `spaceId` is provided the row must match it (the common space-scoped read);
 *  omit it for the rare unscoped `.eq('id')` reads (applications/pdf, status, etc.). */
export const getById = query({
  args: { id: v.string(), spaceId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('Contact')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c) return null;
    if (args.spaceId !== undefined && c.spaceId !== args.spaceId) return null;
    return toRow(c);
  },
});

/** Many contacts by id set, scoped to a space. Mirrors `.in('id',[]).eq('spaceId')`
 *  (agent memory/insights/calls, deals contact-resolve). Preserves input → returns
 *  only the rows that exist AND live in the space. */
export const getManyByIds = query({
  args: { ids: v.array(v.string()), spaceId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const out: ReturnType<typeof toRow>[] = [];
    for (const id of args.ids) {
      const c = await ctx.db
        .query('Contact')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (!c) continue;
      if (args.spaceId !== undefined && c.spaceId !== args.spaceId) continue;
      out.push(toRow(c));
    }
    return out;
  },
});

/** First contact in a space whose email matches (case-insensitive), or null.
 *  Mirrors the dedup/booking probe `.eq('spaceId').ilike('email', value).maybeSingle()`
 *  (POST contacts dedup, demos/book, demos/convert). We scan the space and compare
 *  lowercased, matching PG's lower(email) semantics. */
export const findByEmailInSpace = query({
  args: { spaceId: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    const needle = args.email.trim().toLowerCase();
    const rows = await ctx.db
      .query('Contact')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const hit = rows.find((c) => (c.email ?? '').toLowerCase() === needle);
    return hit ? toRow(hit) : null;
  },
});

/** Resolve a contact by exact phone within a space, or null. Mirrors the SMS
 *  audit-link lookup `.eq('spaceId').is('companyId', null).eq('phone', x)
 *  .maybeSingle()` (pass requireCompanyIdNull to apply the workspace-only gate). */
export const findByPhoneInSpace = query({
  args: {
    spaceId: v.string(),
    phone: v.string(),
    requireCompanyIdNull: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const needle = args.phone.trim();
    const rows = await ctx.db
      .query('Contact')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const hit = rows.find(
      (c) =>
        (c.phone ?? '') === needle &&
        (!args.requireCompanyIdNull || c.companyId == null),
    );
    return hit ? toRow(hit) : null;
  },
});

/** One contact by id whose email also matches (case-insensitive), or null. The
 *  client-portal id+email gate (`.eq('id').ilike('email').maybeSingle()`). */
export const getByIdAndEmail = query({
  args: { id: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('Contact')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c) return null;
    return (c.email ?? '').toLowerCase() === args.email.trim().toLowerCase() ? toRow(c) : null;
  },
});

/** Every contact across ALL spaces whose email matches (case-insensitive),
 *  newest-first. The client-portal "find my applications by email" read
 *  (`.ilike('email', x).order(createdAt desc)`, no space scope). Uses the global
 *  by_email index. */
export const listByEmailAllSpaces = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const needle = args.email.trim().toLowerCase();
    const rows = await ctx.db.query('Contact').collect();
    return rows
      .filter((c) => (c.email ?? '').toLowerCase() === needle)
      .sort(descByCreated)
      .map(toRow);
  },
});

/** The most-recent application contact in a space matching an email AND carrying
 *  a tag, or null. The apply-route dedup `.eq('spaceId').ilike('email')
 *  .contains('tags',[tag]).order(createdAt desc).limit(1)`. */
export const findApplicationByEmailInSpace = query({
  args: { spaceId: v.string(), email: v.string(), tag: v.string() },
  handler: async (ctx, args) => {
    const needle = args.email.trim().toLowerCase();
    const rows = await ctx.db
      .query('Contact')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const hit = rows
      .filter((c) => (c.email ?? '').toLowerCase() === needle && c.tags.includes(args.tag))
      .sort(descByCreated)[0];
    return hit ? toRow(hit) : null;
  },
});

/** Recent contacts in a space matching an exact name AND a tag, created since a
 *  cutoff, newest-first, capped. The apply-route name-dedup window
 *  (`.eq('spaceId').eq('name').contains('tags',[tag]).gte('createdAt', cutoff)
 *  .order(createdAt desc).limit(n)`). */
export const recentByNameAndTag = query({
  args: {
    spaceId: v.string(),
    name: v.string(),
    tag: v.string(),
    sinceIso: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Contact')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows
      .filter(
        (c) =>
          c.name === args.name &&
          c.tags.includes(args.tag) &&
          c.createdAt >= args.sinceIso,
      )
      .sort(descByCreated)
      .slice(0, args.limit ?? 5)
      .map(toRow);
  },
});

/** Contacts whose followUpAt falls in [from, to], across ALL spaces, for the
 *  follow-up-reminders cron (`.lte('followUpAt', to).gte('followUpAt', from)`,
 *  no space scope). Whole-table scan — the cron is infrequent. */
export const dueFollowUpsInWindow = query({
  args: { from: v.string(), to: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query('Contact').collect();
    return rows
      .filter((c) => c.followUpAt != null && c.followUpAt >= args.from && c.followUpAt <= args.to)
      .sort(descByCreated)
      .map(toRow);
  },
});

/** Resolve an applicant by (applicationRef [+ statusPortalToken]) — the public
 *  portal gate. Mirrors `.eq('applicationRef').eq('statusPortalToken').maybeSingle()`
 *  (portal, demo-request, portal/message) and the `.eq('applicationRef').eq('spaceId')`
 *  status-page read. Pass whichever scoping the caller used; all provided fields
 *  must match. */
export const findByApplicationRef = query({
  args: {
    applicationRef: v.string(),
    statusPortalToken: v.optional(v.string()),
    spaceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Contact')
      .withIndex('by_application_ref', (q) => q.eq('applicationRef', args.applicationRef))
      .collect();
    const hit = rows.find(
      (c) =>
        (args.statusPortalToken === undefined || c.statusPortalToken === args.statusPortalToken) &&
        (args.spaceId === undefined || c.spaceId === args.spaceId),
    );
    return hit ? toRow(hit) : null;
  },
});

// ── Space-scoped list reads ──────────────────────────────────────────────────

/**
 * The seller People view (GET /api/contacts) and any space-scoped contact list,
 * with the full filter surface that route built in SQL:
 *  - companyId IS NULL gate (exclude manager/company leads) — `excludeCompanyLeads`
 *  - snooze hygiene: hide currently-snoozed by default; `onlySnoozed`/`includeSnoozed`
 *  - multi-token forgiving search over name/email/phone/preferences (AND across
 *    tokens, OR within a token) — the `.or(ilike)` chains, done in-handler
 *  - `type` filter (≠ 'ALL')
 *  - newest-first, offset/limit paging
 * Also serves the realtime-session / MCP list (no companyId gate, just spaceId +
 * optional type, ordered createdAt desc, capped) via the same args.
 */
export const listForSpace = query({
  args: {
    spaceId: v.string(),
    search: v.optional(v.string()),
    type: v.optional(v.string()),
    leadType: v.optional(v.string()),
    excludeCompanyLeads: v.optional(v.boolean()),
    includeSnoozed: v.optional(v.boolean()),
    onlySnoozed: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows = await ctx.db
      .query('Contact')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .collect();

    if (args.excludeCompanyLeads) rows = rows.filter((c) => c.companyId == null);

    const now = new Date().toISOString();
    if (args.onlySnoozed) {
      rows = rows.filter((c) => c.snoozedUntil != null && c.snoozedUntil > now);
    } else if (!args.includeSnoozed) {
      rows = rows.filter((c) => c.snoozedUntil == null || c.snoozedUntil <= now);
    }

    if (args.type && args.type !== 'ALL') rows = rows.filter((c) => c.type === args.type);
    if (args.leadType) rows = rows.filter((c) => c.leadType === args.leadType);

    if (args.search && args.search.trim()) {
      const tokens = args.search
        .slice(0, 100)
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .slice(0, 8);
      for (const token of tokens) {
        rows = rows.filter((c) => {
          const hay = [c.name, c.email ?? '', c.phone ?? '', c.preferences ?? '']
            .join('\n')
            .toLowerCase();
          return hay.includes(token);
        });
      }
    }

    const offset = Math.max(0, args.offset ?? 0);
    const limit = Math.min(Math.max(1, args.limit ?? 500), 1000);
    return rows.slice(offset, offset + limit).map(toRow);
  },
});

/**
 * Contacts across MANY spaces (manager surfaces that PG did with
 * `.in('spaceId',[...])`), newest-first, with optional type + multi-token search
 * over name/email/phone. Loops the `by_space` index per space and unions. Backs
 * GET /api/manager/contacts and the manager leads list of seller spaces.
 */
export const listForSpaces = query({
  args: {
    spaceIds: v.array(v.string()),
    search: v.optional(v.string()),
    type: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows: Doc<'Contact'>[] = [];
    for (const spaceId of args.spaceIds) {
      const part = await ctx.db
        .query('Contact')
        .withIndex('by_space', (q) => q.eq('spaceId', spaceId))
        .collect();
      rows.push(...part);
    }
    if (args.type && args.type !== 'ALL') rows = rows.filter((c) => c.type === args.type);
    if (args.search && args.search.trim()) {
      const tokens = args.search
        .slice(0, 100)
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .slice(0, 8);
      for (const token of tokens) {
        rows = rows.filter((c) => {
          const hay = [c.name, c.email ?? '', c.phone ?? ''].join('\n').toLowerCase();
          return hay.includes(token);
        });
      }
    }
    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    const offset = Math.max(0, args.offset ?? 0);
    const limit = Math.min(Math.max(1, args.limit ?? 500), 1000);
    return rows.slice(offset, offset + limit).map(toRow);
  },
});

/**
 * A company's leads (manager Leads page): `.eq('companyId').order(createdAt desc)`,
 * plus the seller-owned "company-lead" variant (`.in('spaceId',[]).is('companyId',
 * null).contains('tags',['company-lead'])`). Pass `companyId` for the former, or
 * `spaceIds`+`requireCompanyIdNull`+`tagsAll` for the latter.
 */
export const listForCompany = query({
  args: { companyId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Contact')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .collect();
    rows.sort(descByCreated);
    return rows.slice(0, args.limit ?? 500).map(toRow);
  },
});

/**
 * The big tag-filtered space-set rollup the manager/admin/seller surfaces lean on.
 * Replaces the many `.in('spaceId',[...])` / `.eq('spaceId')` reads that add
 * `.contains('tags',[...])` (new-lead, application-link, company-lead,
 * assigned-by-manager, sla-nudged, sla-escalated), `.overlaps('tags',[...])`,
 * companyId-null, lastContactedAt null/not-null, followUpAt windows, and createdAt
 * windows — returning rows so the caller folds them exactly as before. Every
 * predicate is optional; ordering newest-first.
 *
 * Use `count: true` (via the sibling `countForSpaces`) when only the tally matters.
 */
export const filterForSpaces = query({
  args: {
    spaceIds: v.array(v.string()),
    tagsAll: v.optional(v.array(v.string())), // .contains(tags, X)
    tagsAny: v.optional(v.array(v.string())), // .overlaps(tags, X)
    tagsNotAll: v.optional(v.array(v.string())), // .not(tags, cs, X) — exclude rows containing all
    type: v.optional(v.string()),
    typeIn: v.optional(v.array(v.string())),
    leadType: v.optional(v.string()),
    scoreLabel: v.optional(v.string()),
    scoringStatus: v.optional(scoringStatusValidator),
    requireCompanyIdNull: v.optional(v.boolean()),
    requireCompanyIdNotNull: v.optional(v.boolean()),
    minLeadScore: v.optional(v.number()),
    lastContactedNull: v.optional(v.boolean()),
    lastContactedNotNull: v.optional(v.boolean()),
    lastContactedGte: v.optional(v.string()),
    followUpNotNull: v.optional(v.boolean()),
    followUpLt: v.optional(v.string()),
    followUpLte: v.optional(v.string()),
    followUpGte: v.optional(v.string()),
    createdGte: v.optional(v.string()),
    createdLte: v.optional(v.string()),
    snoozedNull: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return (await filterRows(ctx, args)).slice(0, args.limit ?? 100000).map(toRow);
  },
});

/** COUNT-only sibling of filterForSpaces — the `count: 'exact', head: true` reads
 *  (admin/manager/seller-layout/intake badges, morning/notifications tallies). Same
 *  predicate surface; returns a number. */
export const countForSpaces = query({
  args: {
    spaceIds: v.array(v.string()),
    tagsAll: v.optional(v.array(v.string())),
    tagsAny: v.optional(v.array(v.string())),
    tagsNotAll: v.optional(v.array(v.string())),
    type: v.optional(v.string()),
    typeIn: v.optional(v.array(v.string())),
    leadType: v.optional(v.string()),
    scoreLabel: v.optional(v.string()),
    scoringStatus: v.optional(scoringStatusValidator),
    requireCompanyIdNull: v.optional(v.boolean()),
    requireCompanyIdNotNull: v.optional(v.boolean()),
    minLeadScore: v.optional(v.number()),
    lastContactedNull: v.optional(v.boolean()),
    lastContactedNotNull: v.optional(v.boolean()),
    lastContactedGte: v.optional(v.string()),
    followUpNotNull: v.optional(v.boolean()),
    followUpLt: v.optional(v.string()),
    followUpLte: v.optional(v.string()),
    followUpGte: v.optional(v.string()),
    createdGte: v.optional(v.string()),
    createdLte: v.optional(v.string()),
    snoozedNull: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<number> => {
    return (await filterRows(ctx, args)).length;
  },
});

type FilterArgs = {
  spaceIds: string[];
  tagsAll?: string[];
  tagsAny?: string[];
  tagsNotAll?: string[];
  type?: string;
  typeIn?: string[];
  leadType?: string;
  scoreLabel?: string;
  scoringStatus?: 'pending' | 'scored' | 'failed';
  requireCompanyIdNull?: boolean;
  requireCompanyIdNotNull?: boolean;
  minLeadScore?: number;
  lastContactedNull?: boolean;
  lastContactedNotNull?: boolean;
  lastContactedGte?: string;
  followUpNotNull?: boolean;
  followUpLt?: string;
  followUpLte?: string;
  followUpGte?: string;
  createdGte?: string;
  createdLte?: string;
  snoozedNull?: boolean;
};

/** Shared predicate engine for filterForSpaces / countForSpaces. Scans each space
 *  on the by_space index, applies every provided predicate, returns rows sorted
 *  newest-first (callers that need a different order re-sort the projection). */
async function filterRows(ctx: QueryCtx, args: FilterArgs): Promise<Doc<'Contact'>[]> {
  let rows: Doc<'Contact'>[] = [];
  for (const spaceId of args.spaceIds) {
    const part = await ctx.db
      .query('Contact')
      .withIndex('by_space', (q) => q.eq('spaceId', spaceId))
      .collect();
    rows.push(...part);
  }
  if (args.requireCompanyIdNull) rows = rows.filter((c) => c.companyId == null);
  if (args.requireCompanyIdNotNull) rows = rows.filter((c) => c.companyId != null);
  if (args.tagsAll && args.tagsAll.length) rows = rows.filter((c) => hasAllTags(c, args.tagsAll!));
  if (args.tagsAny && args.tagsAny.length) rows = rows.filter((c) => overlapsTags(c, args.tagsAny!));
  if (args.tagsNotAll && args.tagsNotAll.length)
    rows = rows.filter((c) => !hasAllTags(c, args.tagsNotAll!));
  if (args.type) rows = rows.filter((c) => c.type === args.type);
  if (args.typeIn && args.typeIn.length) rows = rows.filter((c) => args.typeIn!.includes(c.type));
  if (args.leadType) rows = rows.filter((c) => c.leadType === args.leadType);
  if (args.scoreLabel) rows = rows.filter((c) => c.scoreLabel === args.scoreLabel);
  if (args.scoringStatus) rows = rows.filter((c) => c.scoringStatus === args.scoringStatus);
  if (args.minLeadScore !== undefined)
    rows = rows.filter((c) => c.leadScore != null && c.leadScore >= args.minLeadScore!);
  if (args.lastContactedNull) rows = rows.filter((c) => c.lastContactedAt == null);
  if (args.lastContactedNotNull) rows = rows.filter((c) => c.lastContactedAt != null);
  if (args.lastContactedGte !== undefined)
    rows = rows.filter((c) => c.lastContactedAt != null && c.lastContactedAt >= args.lastContactedGte!);
  if (args.followUpNotNull) rows = rows.filter((c) => c.followUpAt != null);
  if (args.followUpLt !== undefined)
    rows = rows.filter((c) => c.followUpAt != null && c.followUpAt < args.followUpLt!);
  if (args.followUpLte !== undefined)
    rows = rows.filter((c) => c.followUpAt != null && c.followUpAt <= args.followUpLte!);
  if (args.followUpGte !== undefined)
    rows = rows.filter((c) => c.followUpAt != null && c.followUpAt >= args.followUpGte!);
  if (args.createdGte !== undefined) rows = rows.filter((c) => c.createdAt >= args.createdGte!);
  if (args.createdLte !== undefined) rows = rows.filter((c) => c.createdAt <= args.createdLte!);
  if (args.snoozedNull) rows = rows.filter((c) => c.snoozedUntil == null);
  rows.sort(descByCreated);
  return rows;
}

/**
 * Free-text contact search for a single space (command palette / agent find /
 * vector-context name match): `.eq('spaceId').or(name.ilike/email.ilike/phone.ilike
 * [/preferences.ilike])`, capped. Returns full rows, newest-updated first when no
 * explicit order. Single OR group (any field), unlike listForSpace's multi-token AND.
 */
export const searchInSpace = query({
  args: {
    spaceId: v.string(),
    q: v.string(),
    fields: v.optional(v.array(v.string())), // default name,email,phone
    requireCompanyIdNull: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const needle = args.q.trim().toLowerCase();
    if (!needle) return [];
    const fields = args.fields ?? ['name', 'email', 'phone'];
    let rows = await ctx.db
      .query('Contact')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    if (args.requireCompanyIdNull) rows = rows.filter((c) => c.companyId == null);
    rows = rows.filter((c) => {
      const parts: string[] = [];
      if (fields.includes('name')) parts.push(c.name);
      if (fields.includes('email')) parts.push(c.email ?? '');
      if (fields.includes('phone')) parts.push(c.phone ?? '');
      if (fields.includes('preferences')) parts.push(c.preferences ?? '');
      return parts.join('\n').toLowerCase().includes(needle);
    });
    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return rows.slice(0, args.limit ?? 8).map(toRow);
  },
});

/**
 * Follow-up sweeps: contacts whose followUpAt is in a window, ordered by followUpAt
 * ASC, capped. Replaces the today/morning/notifications/member-dashboard/MCP/
 * follow-ups-page reads (`.not(followUpAt,is,null).lte(followUpAt,now)` etc.).
 * Optional companyId-null gate and a since-bound (cron reminder uses gte..lte).
 */
export const followUpsForSpaces = query({
  args: {
    spaceIds: v.array(v.string()),
    lte: v.optional(v.string()),
    gte: v.optional(v.string()),
    requireCompanyIdNull: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows: Doc<'Contact'>[] = [];
    for (const spaceId of args.spaceIds) {
      const part = await ctx.db
        .query('Contact')
        .withIndex('by_space_followup', (q) => q.eq('spaceId', spaceId))
        .collect();
      rows.push(...part);
    }
    rows = rows.filter((c) => c.followUpAt != null);
    if (args.requireCompanyIdNull) rows = rows.filter((c) => c.companyId == null);
    if (args.lte !== undefined) rows = rows.filter((c) => c.followUpAt! <= args.lte!);
    if (args.gte !== undefined) rows = rows.filter((c) => c.followUpAt! >= args.gte!);
    rows.sort((a, b) => (a.followUpAt! < b.followUpAt! ? -1 : a.followUpAt! > b.followUpAt! ? 1 : 0));
    return rows.slice(0, args.limit ?? 100000).map(toRow);
  },
});

/**
 * Hot/score-ranked contacts in a space, ordered by leadScore DESC, capped.
 * Replaces find-quiet-hot / morning hot-lead / tip "hot lead dormant" reads
 * (`.eq('scoreLabel','hot')` or `.gte('leadScore',thr)`, order leadScore desc).
 * Optional lastContacted-before bound (dormant) + companyId-null gate.
 */
export const topByScoreForSpace = query({
  args: {
    spaceId: v.string(),
    scoreLabel: v.optional(v.string()),
    minLeadScore: v.optional(v.number()),
    lastContactedBefore: v.optional(v.string()),
    requireCompanyIdNull: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows = await ctx.db
      .query('Contact')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    if (args.requireCompanyIdNull) rows = rows.filter((c) => c.companyId == null);
    if (args.scoreLabel) rows = rows.filter((c) => c.scoreLabel === args.scoreLabel);
    if (args.minLeadScore !== undefined)
      rows = rows.filter((c) => c.leadScore != null && c.leadScore >= args.minLeadScore!);
    if (args.lastContactedBefore !== undefined)
      rows = rows.filter(
        (c) => c.lastContactedAt == null || c.lastContactedAt < args.lastContactedBefore!,
      );
    rows.sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));
    return rows.slice(0, args.limit ?? 40).map(toRow);
  },
});

/**
 * Raw projection scan of a space's contacts for analytics/portfolio/scoring health
 * (`.eq('spaceId')` with no extra filter, possibly large cap). Returns full rows;
 * the caller projects. Also covers the admin scoringStatus='failed' global scan via
 * the `scoringStatus` filter and the all-spaces variant via `spaceIds`.
 */
export const scanForAnalytics = query({
  args: {
    spaceId: v.optional(v.string()),
    spaceIds: v.optional(v.array(v.string())),
    scoringStatus: v.optional(scoringStatusValidator),
    requireScoreLabelNotNull: v.optional(v.boolean()),
    requireLeadScoreNotNull: v.optional(v.boolean()),
    requireFormConfigSnapshotNotNull: v.optional(v.boolean()),
    requireSourceLabelNotNull: v.optional(v.boolean()),
    createdGte: v.optional(v.string()),
    // Tag-overlap (PG `.overlaps('tags', [...])`) — admin form-analytics.
    tagsAny: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows: Doc<'Contact'>[];
    if (args.spaceId !== undefined) {
      rows = await ctx.db
        .query('Contact')
        .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId!))
        .collect();
    } else if (args.spaceIds !== undefined) {
      rows = [];
      for (const spaceId of args.spaceIds) {
        const part = await ctx.db
          .query('Contact')
          .withIndex('by_space', (q) => q.eq('spaceId', spaceId))
          .collect();
        rows.push(...part);
      }
    } else {
      // Whole-table scan (admin scoring-health global counts/lists).
      rows = await ctx.db.query('Contact').collect();
    }
    if (args.scoringStatus) rows = rows.filter((c) => c.scoringStatus === args.scoringStatus);
    if (args.requireScoreLabelNotNull) rows = rows.filter((c) => c.scoreLabel != null);
    if (args.requireLeadScoreNotNull) rows = rows.filter((c) => c.leadScore != null);
    if (args.requireFormConfigSnapshotNotNull)
      rows = rows.filter((c) => c.formConfigSnapshot != null);
    if (args.requireSourceLabelNotNull) rows = rows.filter((c) => c.sourceLabel != null);
    if (args.createdGte !== undefined) rows = rows.filter((c) => c.createdAt >= args.createdGte!);
    if (args.tagsAny && args.tagsAny.length > 0)
      rows = rows.filter((c) => c.tags.some((t) => args.tagsAny!.includes(t)));
    rows.sort(descByCreated);
    return rows.slice(0, args.limit ?? 100000).map(toRow);
  },
});

/** Global COUNT over the whole Contact table with optional scoringStatus /
 *  followUp / createdAt filters — admin dashboard + scoring-health top-line tallies
 *  (`.select('*',{count,head})` with no spaceId). */
export const countAll = query({
  args: {
    scoringStatus: v.optional(scoringStatusValidator),
    followUpNotNull: v.optional(v.boolean()),
    createdGte: v.optional(v.string()),
    // Tag-overlap (PG `.overlaps('tags', [...])`): match if the row carries ANY
    // of these tags. The admin form-analytics global rollups (application-link /
    // company-lead populations).
    tagsAny: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<number> => {
    let rows = await ctx.db.query('Contact').collect();
    if (args.scoringStatus) rows = rows.filter((c) => c.scoringStatus === args.scoringStatus);
    if (args.followUpNotNull) rows = rows.filter((c) => c.followUpAt != null);
    if (args.createdGte !== undefined) rows = rows.filter((c) => c.createdAt >= args.createdGte!);
    if (args.tagsAny && args.tagsAny.length > 0)
      rows = rows.filter((c) => c.tags.some((t) => args.tagsAny!.includes(t)));
    return rows.length;
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/** Full insert payload — every column a route/tool sets on create. spaceId+name
 *  required; the rest optional. Arrays default []; type defaults 'QUALIFICATION';
 *  leadType 'rental'; scoringStatus 'pending'. The lib does its own validation/
 *  truncation/dedup BEFORE calling this (mirrors the old insert). */
export const create = mutation({
  args: {
    spaceId: v.string(),
    name: v.string(),
    email: v.optional(v.union(v.string(), v.null())),
    phone: v.optional(v.union(v.string(), v.null())),
    leadType: v.optional(leadTypeValidator),
    address: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    budget: v.optional(v.union(v.number(), v.null())),
    preferences: v.optional(v.union(v.string(), v.null())),
    products: v.optional(v.array(v.string())),
    type: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    leadScore: v.optional(v.union(v.number(), v.null())),
    scoreLabel: v.optional(v.union(v.string(), v.null())),
    scoreSummary: v.optional(v.union(v.string(), v.null())),
    scoringStatus: v.optional(scoringStatusValidator),
    scoreDetails: v.optional(v.any()),
    sourceLabel: v.optional(v.union(v.string(), v.null())),
    companyId: v.optional(v.union(v.string(), v.null())),
    formLeadType: v.optional(v.union(v.string(), v.null())),
    applicationData: v.optional(v.any()),
    applicationRef: v.optional(v.union(v.string(), v.null())),
    applicationStatus: v.optional(v.union(v.string(), v.null())),
    statusPortalToken: v.optional(v.union(v.string(), v.null())),
    formConfigSnapshot: v.optional(v.any()),
    consentGiven: v.optional(v.union(v.boolean(), v.null())),
    consentTimestamp: v.optional(v.union(v.string(), v.null())),
    consentIp: v.optional(v.union(v.string(), v.null())),
    consentPrivacyPolicyUrl: v.optional(v.union(v.string(), v.null())),
    sourceDemoId: v.optional(v.union(v.string(), v.null())),
    id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    // Only persist provided, non-null scalars; absent ⇔ SQL NULL (omit the key).
    const set = <T>(val: T | null | undefined): T | undefined =>
      val === null || val === undefined ? undefined : val;
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      spaceId: args.spaceId,
      name: args.name,
      ...(set(args.email) !== undefined ? { email: set(args.email) } : {}),
      ...(set(args.phone) !== undefined ? { phone: set(args.phone) } : {}),
      leadType: args.leadType ?? ('rental' as const),
      ...(set(args.address) !== undefined ? { address: set(args.address) } : {}),
      ...(set(args.notes) !== undefined ? { notes: set(args.notes) } : {}),
      ...(set(args.budget) !== undefined ? { budget: set(args.budget) } : {}),
      ...(set(args.preferences) !== undefined ? { preferences: set(args.preferences) } : {}),
      products: args.products ?? [],
      type: args.type ?? 'QUALIFICATION',
      tags: args.tags ?? [],
      ...(set(args.leadScore) !== undefined ? { leadScore: set(args.leadScore) } : {}),
      ...(set(args.scoreLabel) !== undefined ? { scoreLabel: set(args.scoreLabel) } : {}),
      ...(set(args.scoreSummary) !== undefined ? { scoreSummary: set(args.scoreSummary) } : {}),
      scoringStatus: args.scoringStatus ?? ('pending' as const),
      ...(args.scoreDetails !== undefined ? { scoreDetails: args.scoreDetails } : {}),
      ...(set(args.sourceLabel) !== undefined ? { sourceLabel: set(args.sourceLabel) } : {}),
      ...(set(args.companyId) !== undefined ? { companyId: set(args.companyId) } : {}),
      ...(set(args.formLeadType) !== undefined ? { formLeadType: set(args.formLeadType) } : {}),
      ...(args.applicationData !== undefined ? { applicationData: args.applicationData } : {}),
      ...(set(args.applicationRef) !== undefined ? { applicationRef: set(args.applicationRef) } : {}),
      ...(set(args.applicationStatus) !== undefined
        ? { applicationStatus: set(args.applicationStatus) }
        : {}),
      ...(set(args.statusPortalToken) !== undefined
        ? { statusPortalToken: set(args.statusPortalToken) }
        : {}),
      ...(args.formConfigSnapshot !== undefined
        ? { formConfigSnapshot: args.formConfigSnapshot }
        : {}),
      ...(set(args.consentGiven) !== undefined ? { consentGiven: set(args.consentGiven) } : {}),
      ...(set(args.consentTimestamp) !== undefined
        ? { consentTimestamp: set(args.consentTimestamp) }
        : {}),
      ...(set(args.consentIp) !== undefined ? { consentIp: set(args.consentIp) } : {}),
      ...(set(args.consentPrivacyPolicyUrl) !== undefined
        ? { consentPrivacyPolicyUrl: set(args.consentPrivacyPolicyUrl) }
        : {}),
      ...(set(args.sourceDemoId) !== undefined ? { sourceDemoId: set(args.sourceDemoId) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('Contact', doc);
    return toRow(doc as ContactFields);
  },
});

/** Bulk insert (CSV import — POST contacts/import, manager leads/import). One row
 *  per item; ids generated when absent. Returns the count inserted. Mirrors the
 *  array `.insert([...])` the import routes did. */
export const createMany = mutation({
  args: {
    rows: v.array(
      v.object({
        spaceId: v.string(),
        name: v.string(),
        email: v.optional(v.union(v.string(), v.null())),
        phone: v.optional(v.union(v.string(), v.null())),
        leadType: v.optional(leadTypeValidator),
        address: v.optional(v.union(v.string(), v.null())),
        notes: v.optional(v.union(v.string(), v.null())),
        budget: v.optional(v.union(v.number(), v.null())),
        preferences: v.optional(v.union(v.string(), v.null())),
        products: v.optional(v.array(v.string())),
        type: v.optional(v.string()),
        tags: v.optional(v.array(v.string())),
        scoringStatus: v.optional(scoringStatusValidator),
        companyId: v.optional(v.union(v.string(), v.null())),
        applicationData: v.optional(v.any()),
        id: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ inserted: number; ids: string[] }> => {
    const now = new Date().toISOString();
    const ids: string[] = [];
    for (const r of args.rows) {
      const set = <T>(val: T | null | undefined): T | undefined =>
        val === null || val === undefined ? undefined : val;
      const id = r.id ?? crypto.randomUUID();
      await ctx.db.insert('Contact', {
        id,
        spaceId: r.spaceId,
        name: r.name,
        ...(set(r.email) !== undefined ? { email: set(r.email) } : {}),
        ...(set(r.phone) !== undefined ? { phone: set(r.phone) } : {}),
        leadType: r.leadType ?? ('rental' as const),
        ...(set(r.address) !== undefined ? { address: set(r.address) } : {}),
        ...(set(r.notes) !== undefined ? { notes: set(r.notes) } : {}),
        ...(set(r.budget) !== undefined ? { budget: set(r.budget) } : {}),
        ...(set(r.preferences) !== undefined ? { preferences: set(r.preferences) } : {}),
        products: r.products ?? [],
        type: r.type ?? 'QUALIFICATION',
        tags: r.tags ?? [],
        scoringStatus: r.scoringStatus ?? ('pending' as const),
        ...(set(r.companyId) !== undefined ? { companyId: set(r.companyId) } : {}),
        ...(r.applicationData !== undefined ? { applicationData: r.applicationData } : {}),
        createdAt: now,
        updatedAt: now,
      });
      ids.push(id);
    }
    return { inserted: ids.length, ids };
  },
});

/**
 * Patch a contact by id, optionally CAS-scoped to a space (the routes append
 * `.eq('spaceId')` as a TOCTOU guard). Covers EVERY `.from('Contact').update(...)`:
 * the People PATCH (name/email/phone/address/notes/preferences/products/tags/
 * budget/type/followUpAt/lastContactedAt/sourceLabel/referralSource/snoozedUntil),
 * scoring writes (scoringStatus/leadScore/scoreLabel/scoreSummary/scoreDetails),
 * mark hot/cold, set/clear follow-up, archive, last-contacted bumps, application*
 * updates, assignment notes, and the SLA/leads-page tag flips. Only keys present
 * in `patch` are written; `null` clears a column (set to undefined → Convex
 * removes it ⇔ SQL NULL). Always stamps updatedAt unless the caller passes one.
 *
 * `setSourceLabelOnlyIfNull` mirrors demos/book's `.is('sourceLabel', null)` CAS:
 * the sourceLabel write is skipped if the row already has one.
 * `stageChangedOnTypeChange` mirrors the People PATCH rule (bump stageChangedAt
 * iff `type` actually changes). `followUpOnlyIfNull` mirrors demos/[id]'s
 * `.is('followUpAt', null)` guard.
 * Returns the updated row, or null if not found / space-scope mismatch.
 */
export const update = mutation({
  args: {
    id: v.string(),
    spaceId: v.optional(v.string()),
    companyId: v.optional(v.string()), // alt CAS scope (manager binding by companyId)
    patch: v.object({
      name: v.optional(v.string()),
      email: v.optional(v.union(v.string(), v.null())),
      phone: v.optional(v.union(v.string(), v.null())),
      address: v.optional(v.union(v.string(), v.null())),
      notes: v.optional(v.union(v.string(), v.null())),
      preferences: v.optional(v.union(v.string(), v.null())),
      products: v.optional(v.array(v.string())),
      tags: v.optional(v.array(v.string())),
      budget: v.optional(v.union(v.number(), v.null())),
      type: v.optional(v.string()),
      leadType: v.optional(leadTypeValidator),
      followUpAt: v.optional(v.union(v.string(), v.null())),
      lastContactedAt: v.optional(v.union(v.string(), v.null())),
      snoozedUntil: v.optional(v.union(v.string(), v.null())),
      sourceLabel: v.optional(v.union(v.string(), v.null())),
      referralSource: v.optional(v.union(v.string(), v.null())),
      scoringStatus: v.optional(scoringStatusValidator),
      leadScore: v.optional(v.union(v.number(), v.null())),
      scoreLabel: v.optional(v.union(v.string(), v.null())),
      scoreSummary: v.optional(v.union(v.string(), v.null())),
      scoreDetails: v.optional(v.any()),
      applicationStatus: v.optional(v.union(v.string(), v.null())),
      applicationStatusNote: v.optional(v.union(v.string(), v.null())),
      stageChangedAt: v.optional(v.union(v.string(), v.null())),
    }),
    setSourceLabelOnlyIfNull: v.optional(v.boolean()),
    stageChangedOnTypeChange: v.optional(v.boolean()),
    followUpOnlyIfNull: v.optional(v.boolean()),
    updatedAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('Contact')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c) return null;
    if (args.spaceId !== undefined && c.spaceId !== args.spaceId) return null;
    if (args.companyId !== undefined && c.companyId !== args.companyId) return null;

    // Build the write set on a local copy (never mutate the validated args).
    // null → undefined clears the column in Convex (⇔ SQL NULL); undefined is skipped.
    const typeChanged = args.patch.type !== undefined && args.patch.type !== c.type;
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(args.patch)) {
      if (val === undefined) continue;
      // demos/[id]: only set follow-up if the contact currently has none.
      if (k === 'followUpAt' && args.followUpOnlyIfNull && c.followUpAt != null) continue;
      // demos/book: only stamp sourceLabel if currently null.
      if (k === 'sourceLabel' && args.setSourceLabelOnlyIfNull && c.sourceLabel != null) continue;
      patch[k] = val === null ? undefined : val;
    }

    // People PATCH: bump stageChangedAt iff `type` actually changed to a new value.
    if (args.stageChangedOnTypeChange && typeChanged) {
      patch.stageChangedAt = new Date().toISOString();
    }

    patch.updatedAt = args.updatedAt ?? new Date().toISOString();
    await ctx.db.patch(c._id, patch);
    const updated = (await ctx.db.get(c._id))!;
    return toRow(updated);
  },
});

/**
 * Delete a contact by id, CAS-scoped to a space OR companyId binding (the routes
 * scope by whichever they matched). CASCADES to this domain's children:
 * ContactActivity + ContactDocument rows for the contact are removed (PG ON DELETE
 * CASCADE re-implemented as explicit deletes inside one serializable mutation).
 *
 * Returns the deleted contact's (id, spaceId, name, email) plus the storageKeys of
 * the ContactDocument rows it removed — the caller (route / merge tool) still needs
 * those keys to drop the Wasabi objects (which don't cascade) and to clean up
 * cross-domain links (DealContact/Deal) and the search vector, exactly as before.
 * `outcome: 'missing'` when no row matched the id+scope.
 */
export const deleteContact = mutation({
  args: { id: v.string(), spaceId: v.optional(v.string()), companyId: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { outcome: 'deleted'; contact: ReturnType<typeof toRow>; docStorageKeys: string[] }
    | { outcome: 'missing'; contact: null; docStorageKeys: [] }
  > => {
    const c = await ctx.db
      .query('Contact')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c) return { outcome: 'missing', contact: null, docStorageKeys: [] };
    if (args.spaceId !== undefined && c.spaceId !== args.spaceId)
      return { outcome: 'missing', contact: null, docStorageKeys: [] };
    if (args.companyId !== undefined && c.companyId !== args.companyId)
      return { outcome: 'missing', contact: null, docStorageKeys: [] };

    const row = toRow(c);

    // Cascade: ContactDocument (capture storageKeys first — Wasabi doesn't cascade).
    const docs = await ctx.db
      .query('ContactDocument')
      .withIndex('by_contact', (q) => q.eq('contactId', c.id))
      .collect();
    const docStorageKeys = docs.map((d) => d.storageKey).filter((k): k is string => Boolean(k));
    for (const d of docs) await ctx.db.delete(d._id);

    // Cascade: ContactActivity.
    const acts = await ctx.db
      .query('ContactActivity')
      .withIndex('by_contact_created', (q) => q.eq('contactId', c.id))
      .collect();
    for (const a of acts) await ctx.db.delete(a._id);

    await ctx.db.delete(c._id);
    return { outcome: 'deleted', contact: row, docStorageKeys };
  },
});
