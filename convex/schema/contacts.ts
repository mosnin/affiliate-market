import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Contacts domain — the CRM core of Cola: people (leads/buyers/sellers), their
 * activity timeline, their uploaded documents, and the per-seller AI profile.
 * See convex/CONVENTIONS.md for the Postgres -> Convex translation rules every
 * table here follows (string `id`, ISO timestamps as v.string(), CHECK enums ->
 * v.union of v.literal, nullable -> v.optional, jsonb -> v.any, integer counts ->
 * v.number, bool -> v.boolean, text[] -> v.array(v.string())).
 *
 * Contact is the single most-referenced table in the app (~270 call sites). It is
 * read by MANY query shapes — by space, by id, by email (dedup/portal), by
 * applicationRef + statusPortalToken (the public applicant portal), by leadScore /
 * scoreLabel (hot-lead rollups), by followUpAt (overdue sweeps), by tags
 * (lifecycle: new-lead / application-link / company-lead / assigned-by-manager /
 * sla-*), by companyId (manager leads vs. seller People), by scoringStatus (admin
 * health), and by sourceLabel. The indexes below back the high-frequency filters;
 * the remaining predicates (tags overlap, leadType, scoringStatus, free-text
 * ilike, date windows) are applied in-handler after an indexed space scan, which
 * is exactly how the marketplace products domain handles its `.or(ilike)` search.
 *
 * Postgres invariants re-implemented inside the mutations (no native Convex
 * equivalent) — noted per table:
 *   - Contact ON DELETE CASCADE -> ContactActivity + ContactDocument (both THIS
 *     domain's). The deleteContact mutation removes those child rows explicitly.
 *     (Contact also cascades to DealContact/Deal in PG, but those are OTHER
 *     domains — the delete ROUTE keeps orchestrating that cross-backend cleanup,
 *     per CONVENTIONS "cross-domain stays in lib".)
 *   - AIUserProfile UNIQUE(spaceId): one profile per space — every write is an
 *     upsert keyed on spaceId, re-implemented as read-by-space-then-insert-or-patch
 *     inside one serializable mutation.
 *
 * NOTE on AIUserProfile keying: the Wave-A brief described it as "per-user (by
 * userId)", but the live schema + every call site (ai-profile GET/PUT, onboarding
 * save_seller_profile) key it by **spaceId** (the table has no userId column).
 * Indexed by_space accordingly.
 */
export const contactsTables = {
  // Was: "Contact" (TEXT id [app-generated, no DB default], spaceId, name,
  // email/phone nullable, leadType default 'rental' CHECK(rental|buyer|seller),
  // address/notes nullable, budget double precision nullable, preferences
  // nullable, products text[] default {}, type default 'QUALIFICATION', tags
  // text[] default {}, leadScore double precision nullable, scoreLabel nullable,
  // scoreSummary nullable, scoringStatus default 'pending' CHECK(pending|scored|
  // failed), scoreDetails jsonb nullable, applicationData jsonb nullable,
  // followUpAt/lastContactedAt nullable, sourceLabel nullable, companyId nullable,
  // stageChangedAt nullable, applicationRef/applicationStatus/applicationStatusNote
  // nullable, statusPortalToken nullable, consentGiven boolean nullable,
  // consentTimestamp nullable, consentIp/consentPrivacyPolicyUrl nullable,
  // formConfigSnapshot jsonb nullable, formLeadType nullable, createdAt, updatedAt,
  // sourceDemoId nullable, snoozedUntil nullable, referralSource nullable).
  //
  // budget/leadScore are double precision in PG (NOT money cents) -> v.number.
  // `type` is the app's ContactType (QUALIFICATION|DEMO|APPLICATION + legacy
  // values); it is validated in lib, not a fixed DB CHECK, so kept as v.string().
  Contact: defineTable({
    id: v.string(),
    spaceId: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    leadType: v.union(v.literal('rental'), v.literal('buyer'), v.literal('seller')),
    address: v.optional(v.string()),
    notes: v.optional(v.string()),
    budget: v.optional(v.number()), // double precision (NOT cents)
    preferences: v.optional(v.string()),
    products: v.array(v.string()), // text[] (default {})
    type: v.string(), // default 'QUALIFICATION' (ContactType, validated in lib)
    tags: v.array(v.string()), // text[] (default {})
    leadScore: v.optional(v.number()), // double precision
    scoreLabel: v.optional(v.string()),
    scoreSummary: v.optional(v.string()),
    scoringStatus: v.union(v.literal('pending'), v.literal('scored'), v.literal('failed')),
    scoreDetails: v.optional(v.any()), // jsonb
    applicationData: v.optional(v.any()), // jsonb
    followUpAt: v.optional(v.string()), // ISO-8601
    lastContactedAt: v.optional(v.string()), // ISO-8601
    sourceLabel: v.optional(v.string()),
    companyId: v.optional(v.string()),
    stageChangedAt: v.optional(v.string()), // ISO-8601
    applicationRef: v.optional(v.string()),
    applicationStatus: v.optional(v.string()),
    applicationStatusNote: v.optional(v.string()),
    statusPortalToken: v.optional(v.string()),
    consentGiven: v.optional(v.boolean()),
    consentTimestamp: v.optional(v.string()), // ISO-8601
    consentIp: v.optional(v.string()),
    consentPrivacyPolicyUrl: v.optional(v.string()),
    formConfigSnapshot: v.optional(v.any()), // jsonb
    formLeadType: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    sourceDemoId: v.optional(v.string()),
    snoozedUntil: v.optional(v.string()), // ISO-8601
    referralSource: v.optional(v.string()),
  })
    // Every per-row read/update/delete keys by id (contact CRUD, AI tools, agent
    // routes, cards, applications, demos, deals, scoring). idx_contact_app_ref is
    // separate — this is the PK lookup.
    .index('by_app_id', ['id'])
    // The dominant filter: a space's contacts. Backs idx_contact_space_id and the
    // many reads that scan a space then filter in-memory (companyId null, tags,
    // scoringStatus, leadType, search, date windows). Manager rollups that PG did
    // with `.in('spaceId',[...])` loop this index per space and union in-handler.
    .index('by_space', ['spaceId'])
    // contact_space_created_idx = (spaceId, createdAt DESC): seller People list,
    // manager seller views, intake/realtime/MCP lists, weekly/morning rollups —
    // all order a space's contacts newest-first.
    .index('by_space_created', ['spaceId', 'createdAt'])
    // contact_follow_up_idx = (spaceId, followUpAt DESC): the overdue/upcoming
    // follow-up sweeps (today, morning, notifications, follow-ups page, MCP,
    // member-dashboard) filter followUpAt and order by it within a space.
    .index('by_space_followup', ['spaceId', 'followUpAt'])
    // contact_scoring_status_idx = (spaceId, scoringStatus): admin scoring-health
    // and per-space failed/pending counts.
    .index('by_space_scoring_status', ['spaceId', 'scoringStatus'])
    // idx_contact_lead_type = (spaceId, leadType): MCP/dashboard buyer counts and
    // pipeline-type deal creation gate by (spaceId, leadType).
    .index('by_space_lead_type', ['spaceId', 'leadType'])
    // idx_contact_email = (email): the dedup read (`.ilike('email')` within a
    // space — we lower+scan space) AND demo-book/convert email match. We also keep
    // a space-scoped path: most email lookups are space-scoped, so the by_space
    // scan + in-handler email compare mirrors PG's lower(email) semantics. This
    // plain email index serves any cross-space email probe.
    .index('by_email', ['email'])
    // idx_contact_application_ref (applicationRef WHERE NOT NULL): the public
    // applicant portal resolves a contact by (applicationRef [+ statusPortalToken])
    // — applications/portal, demo-request, portal/message, applications/[id]/status
    // re-issue. Token is compared in-handler after this lookup.
    .index('by_application_ref', ['applicationRef'])
    // idx_contact_status_portal_token (statusPortalToken WHERE NOT NULL): the
    // status page can resolve by token; we expose a token index for that path.
    .index('by_status_portal_token', ['statusPortalToken'])
    // idx_contact_company = (companyId): manager company-leads list reads by
    // companyId (and the unassign/lead-note binding checks). Manager "seller-owned
    // company-lead" reads stay on by_space (companyId null) + tag filter.
    .index('by_company', ['companyId']),

  // Was: "ContactActivity" (TEXT id [app-generated], contactId, spaceId, type
  // CHECK enum, content nullable, metadata jsonb nullable, createdAt). The live
  // type CHECK is the WIDE set shared with DealActivity — the codebase inserts
  // 'status_change' and 'stage_change' (mark-person-hot/cold, demo state changes)
  // in addition to the base note/call/email/meeting/follow_up. (setup.sql's
  // narrow ContactActivity CHECK is stale; the materialized DealActivity check +
  // the actual inserts are the source of truth.)
  ContactActivity: defineTable({
    id: v.string(),
    contactId: v.string(),
    spaceId: v.string(),
    type: v.union(
      v.literal('note'),
      v.literal('call'),
      v.literal('email'),
      v.literal('meeting'),
      v.literal('follow_up'),
      v.literal('stage_change'),
      v.literal('status_change'),
    ),
    content: v.optional(v.string()),
    metadata: v.optional(v.any()), // jsonb
    createdAt: v.string(), // ISO-8601 (PG default now())
  })
    // The timeline: a contact's activities newest-first (contact detail page,
    // cards, context-enrichment, find-person last-touch, merge count/move).
    // idx_contact_activity_contact = (contactId). We pair contactId+createdAt so
    // the per-contact timeline reads run on the index and order by time.
    .index('by_contact_created', ['contactId', 'createdAt'])
    // Space-wide activity reads: momentum (type tallies in a window), manager
    // morning/sellers response-time analysis (type ∈ outbound, createdAt window).
    // idx_contact_activity_space = (spaceId). spaceId+createdAt backs the windowed
    // scans; type is filtered in-handler (low-cardinality).
    .index('by_space_created', ['spaceId', 'createdAt']),

  // Was: "ContactDocument" (TEXT id [gen_random_uuid()::text default], contactId,
  // spaceId, fileName, fileType, fileSize integer, storageKey, uploadedBy default
  // 'guest', createdAt). Buyer-uploaded application files (IDs, bank statements).
  ContactDocument: defineTable({
    id: v.string(),
    contactId: v.string(),
    spaceId: v.string(),
    fileName: v.string(),
    fileType: v.string(),
    fileSize: v.number(), // integer bytes
    storageKey: v.string(),
    uploadedBy: v.string(), // default 'guest'
    createdAt: v.string(), // ISO-8601
  })
    // idx_contact_document_contact = (contactId): the documents list + the
    // pre-delete storageKey grab (contact & manager-lead delete) read by contactId.
    .index('by_contact', ['contactId'])
    // documents/[id] GET/DELETE look a single doc up by id.
    .index('by_app_id', ['id'])
    // storage-gc cron probes "is this storageKey still referenced?" via
    // `.in('storageKey',[candidates])`. We expose a by_storage_key index so the GC
    // can check each candidate key on an index instead of a full scan.
    .index('by_storage_key', ['storageKey']),

  // Was: "AIUserProfile" (TEXT id [gen_random_uuid()::text default], spaceId
  // [UNIQUE — one per space], displayName nullable, businessFocus text[] default
  // {}, yearsExperience integer nullable, workingStyle/communicationTone/
  // currentGoals/quirksAndPreferences/agentPersonalizationNote nullable, createdAt,
  // updatedAt, role nullable, zipCode nullable, leadSources text[] default {}).
  // The seller's onboarding-built persona that personalizes the agent. Every
  // access is keyed by spaceId; the upsert (onConflict spaceId) is re-implemented
  // as read-by-space-then-insert-or-patch.
  AIUserProfile: defineTable({
    id: v.string(),
    spaceId: v.string(),
    displayName: v.optional(v.string()),
    businessFocus: v.array(v.string()), // text[] (default {})
    yearsExperience: v.optional(v.number()), // integer
    workingStyle: v.optional(v.string()),
    communicationTone: v.optional(v.string()),
    currentGoals: v.optional(v.string()),
    quirksAndPreferences: v.optional(v.string()),
    agentPersonalizationNote: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    role: v.optional(v.string()),
    zipCode: v.optional(v.string()),
    leadSources: v.array(v.string()), // text[] (default {})
  })
    // AIUserProfile_spaceId_idx + UNIQUE(spaceId): every read/upsert keys by
    // spaceId. The upsert reads this then inserts-or-patches the single row.
    .index('by_space', ['spaceId']),
};
