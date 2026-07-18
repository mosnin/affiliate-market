import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Deals domain tables — the seller pipeline: deals, stages, pipelines, the
 * Deal<->Contact join, per-deal activity/checklist/documents, free-form notes,
 * the manager deal-review thread, and the company lead-routing rules.
 *
 * Translation rules: convex/CONVENTIONS.md (string `id`, ISO-8601 timestamps as
 * v.string(), CHECK enums -> v.union of v.literal, nullable -> v.optional,
 * jsonb -> v.any, integer counts -> v.number, double precision -> v.number,
 * numeric(p,s) -> v.number, bool -> v.boolean). No money cents live in this
 * domain: Deal.value (double precision) and Deal.commissionRate / routing budgets
 * (numeric) are NOT cents — they stay plain v.number as Postgres stored them; the
 * commission/payout math lives in lib and is not recomputed here.
 *
 * Postgres ON DELETE CASCADE chains the code relies on (no native Convex
 * equivalent) are re-implemented as explicit cascade deletes inside the delete
 * mutations, noted per table:
 *   - Deal delete -> CASCADE DealActivity, DealChecklistItem, DealContact,
 *     DealDocument, DealReviewRequest (-> DealReviewComment).
 *   - DealStage delete -> CASCADE Deal (and each Deal's children above). The
 *     stage DELETE route re-homes deals to a target stage first when any exist,
 *     so the cascade only fires for an empty stage.
 *   - DealReviewRequest delete -> CASCADE DealReviewComment.
 *   - DealContact PK (dealId, contactId) is a composite — the join mutations
 *     enforce it via read-then-insert (one membership row per pair).
 *
 * Postgres ON DELETE SET NULL the code relies on cross-backend:
 *   - Deal.productId (Product lives in marketplace/Convex): the Product DELETE
 *     route nulls Deal.productId via clearProductId below.
 *   - DealStage.pipelineId (Pipeline delete): re-homed/cleared in the pipeline
 *     DELETE mutation.
 *   - DealReviewRequest.resolvedByUserId / Deal.sourceDemoId: User/Demo deletes
 *     are not driven from this domain; left as plain optionals.
 *
 * UNIQUE invariant: idx_dealreview_open_per_deal UNIQUE(dealId) WHERE status='open'
 * — at most one OPEN review request per deal. Enforced by a read-then-insert on
 * by_deal_status inside the create mutation.
 */
export const dealsTables = {
  // Was: "Deal" (TEXT id, spaceId, title, description nullable, value double
  // precision nullable, address nullable, priority default 'MEDIUM', closeDate
  // nullable, stageId, position int default 0, status default 'active',
  // followUpAt nullable, sourceDemoId nullable, commissionRate numeric(5,2)
  // nullable, probability int nullable, milestones jsonb default [], createdAt,
  // updatedAt, stageChangedAt nullable, closedAt nullable, nextAction nullable,
  // nextActionDueAt nullable, wonLostReason nullable, wonLostNote nullable,
  // productId nullable). priority/status are the app's CHECK enums.
  Deal: defineTable({
    id: v.string(),
    spaceId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    value: v.optional(v.number()), // double precision (NOT cents)
    address: v.optional(v.string()),
    priority: v.union(v.literal('LOW'), v.literal('MEDIUM'), v.literal('HIGH')),
    closeDate: v.optional(v.string()), // ISO-8601
    stageId: v.string(),
    position: v.number(), // integer
    status: v.union(
      v.literal('active'),
      v.literal('won'),
      v.literal('lost'),
      v.literal('on_hold'),
    ),
    followUpAt: v.optional(v.string()),
    sourceDemoId: v.optional(v.string()),
    commissionRate: v.optional(v.number()), // numeric(5,2), 0..100 (NOT cents)
    probability: v.optional(v.number()), // integer 0..100
    milestones: v.any(), // jsonb array (default [])
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
    stageChangedAt: v.optional(v.string()),
    closedAt: v.optional(v.string()),
    nextAction: v.optional(v.string()),
    nextActionDueAt: v.optional(v.string()),
    wonLostReason: v.optional(v.string()),
    wonLostNote: v.optional(v.string()),
    productId: v.optional(v.string()),
  })
    // Every per-row read/update/delete keys by id (deal CRUD, ai-tools, cards,
    // agent routes, reorder, mcp get_deal).
    .index('by_app_id', ['id'])
    // deal_space_position_idx (spaceId, position): the kanban board list and the
    // many `.eq('spaceId').order('position')` reads. Also the workhorse for the
    // space-scoped status/value aggregations (status filtered in-handler).
    .index('by_space_position', ['spaceId', 'position'])
    // deal_stage_position_idx (stageId, position): next-position computation on
    // insert (`.eq('stageId').order('position', desc).limit(1)`), the per-stage
    // deal lists (stages GET `.in('stageId', ids)`), and the reorder shift.
    .index('by_stage_position', ['stageId', 'position'])
    // deal_status_idx (spaceId, status): status-scoped reads (find_deal,
    // pipeline_summary, forecast, leaderboard, brief). status equality + an
    // in-handler value/date fold.
    .index('by_space_status', ['spaceId', 'status'])
    // deal_follow_up_idx (spaceId, followUpAt DESC): follow-ups page + manager
    // overdue-followup count (`.not('followUpAt', is, null).lte('followUpAt')`).
    .index('by_space_follow_up', ['spaceId', 'followUpAt'])
    // idx_deal_product (productId) WHERE productId IS NOT NULL: products page +
    // products/[id] API list a product's deals; the product DELETE nulls them.
    .index('by_product', ['productId'])
    // idx_deal_source_demo (sourceDemoId): demos/convert "already converted?"
    // check + notifications "demo converted?" lookup.
    .index('by_source_demo', ['sourceDemoId']),

  // Was: "DealStage" (TEXT id, spaceId, name, color default '#6B7280', position
  // int default 0, pipelineType default 'rental' (enum), pipelineId nullable,
  // kind nullable (enum)). pipelineType/kind are the app's CHECK enums.
  DealStage: defineTable({
    id: v.string(),
    spaceId: v.string(),
    name: v.string(),
    color: v.string(), // default '#6B7280'
    position: v.number(), // integer
    pipelineType: v.optional(
      v.union(v.literal('rental'), v.literal('buyer'), v.literal('seller')),
    ),
    pipelineId: v.optional(v.string()),
    kind: v.optional(
      v.union(
        v.literal('lead'),
        v.literal('qualified'),
        v.literal('active'),
        v.literal('under_contract'),
        v.literal('closing'),
        v.literal('closed'),
      ),
    ),
  })
    // Per-stage read/update/delete by id (stages PATCH/DELETE, move-deal-stage,
    // card/notification stage-name lookup, draft-outcomes kind lookup).
    .index('by_app_id', ['id'])
    // idx_dealstage_space_id (spaceId): the space's stage list ordered by
    // position — the kanban columns, every `.eq('spaceId').order('position')`.
    // Position is folded in-handler/by the caller after the space scope.
    .index('by_space', ['spaceId'])
    // idx_deal_stage_pipeline (spaceId, pipelineType): default-stage pickers
    // (`.eq('spaceId').eq('pipelineType').order('position').limit(1)` in create-
    // deal, deals POST buyer/seller routing, stages GET/POST filter).
    .index('by_space_pipeline_type', ['spaceId', 'pipelineType'])
    // DealStage_pipelineId_idx (pipelineId): pipeline-scoped stage list
    // (deals page `.eq('pipelineId')`, pipelines DELETE re-home/clear).
    .index('by_pipeline', ['pipelineId']),

  // Was: "Pipeline" (TEXT id, spaceId, name, color default '#6366f1', emoji
  // nullable, position int default 0, createdAt).
  Pipeline: defineTable({
    id: v.string(),
    spaceId: v.string(),
    name: v.string(),
    color: v.string(), // default '#6366f1'
    emoji: v.optional(v.string()),
    position: v.number(), // integer
    createdAt: v.string(), // ISO-8601
  })
    // pipelines PATCH/DELETE look a pipeline up by id (+ spaceId scope).
    .index('by_app_id', ['id'])
    // Pipeline_spaceId_idx (spaceId): the space's pipeline list ordered by
    // position (deals page, pipelines GET, next-position on POST).
    .index('by_space', ['spaceId']),

  // Was: "Note" (TEXT id, spaceId, title default 'Untitled', content default '',
  // icon nullable, sortOrder int default 0, createdAt, updatedAt).
  Note: defineTable({
    id: v.string(),
    spaceId: v.string(),
    title: v.string(), // default 'Untitled'
    content: v.string(), // default ''
    icon: v.optional(v.string()),
    sortOrder: v.number(), // integer
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // notes GET-by-id / PATCH / DELETE key by id (+ spaceId scope).
    .index('by_app_id', ['id'])
    // idx_note_space (spaceId, sortOrder): the space's notes list ordered by
    // sortOrder (notes GET, mcp list_notes, realtime/voice context, export);
    // also next-sortOrder on POST + the member-dashboard '[ANN]%' title scan.
    .index('by_space_sort', ['spaceId', 'sortOrder']),

  // Was: "DealContact" — the Deal<->Contact join. Composite PK (dealId,
  // contactId), no surrogate id, no createdAt. role nullable (enum). We mirror
  // the table exactly (no `id` column) and enforce the composite PK by
  // read-then-insert in the link mutations.
  DealContact: defineTable({
    dealId: v.string(),
    contactId: v.string(),
    role: v.optional(
      v.union(
        v.literal('buyer'),
        v.literal('seller'),
        v.literal('buyer_agent'),
        v.literal('listing_agent'),
        v.literal('co_agent'),
        v.literal('lender'),
        v.literal('title'),
        v.literal('escrow'),
        v.literal('inspector'),
        v.literal('appraiser'),
        v.literal('attorney'),
        v.literal('other'),
      ),
    ),
  })
    // idx_dealcontact_deal (dealId): a deal's contacts (deal detail, card, stages
    // GET enrich, PATCH role, membership diff on deal update). Also the composite-
    // PK existence check (dealId+contactId folded in-handler).
    .index('by_deal', ['dealId'])
    // idx_dealcontact_contact (contactId): a contact's deals (contact detail/
    // timeline, find-person/find-deal enrich, merge-persons re-link, lead
    // unassign/delete cascade).
    .index('by_contact', ['contactId']),

  // Was: "DealActivity" (TEXT id, dealId, spaceId, type (enum), content nullable,
  // metadata jsonb nullable, createdAt). Append-only timeline row.
  DealActivity: defineTable({
    id: v.string(),
    dealId: v.string(),
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
    createdAt: v.string(), // ISO-8601
  })
    // idx_deal_activity_deal (dealId): a deal's activity feed, newest-first
    // (deal detail, activity GET, card). spaceId asserted in-handler.
    .index('by_deal', ['dealId']),

  // Was: "DealChecklistItem" (TEXT id, dealId, spaceId, kind, label, dueAt
  // nullable, completedAt nullable, position int default 0, createdAt, updatedAt).
  DealChecklistItem: defineTable({
    id: v.string(),
    dealId: v.string(),
    spaceId: v.string(),
    kind: v.string(),
    label: v.string(),
    dueAt: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    position: v.number(), // integer
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // Per-item PATCH/DELETE key by id (+ dealId + spaceId scope).
    .index('by_app_id', ['id'])
    // idx_deal_checklist_deal (dealId, position): a deal's checklist ordered by
    // position (checklist GET, stages GET enrich, next-position + count on POST,
    // shift route). spaceId asserted in-handler where the route scoped it.
    .index('by_deal_position', ['dealId', 'position']),

  // Was: "DealDocument" (TEXT id, dealId, spaceId, kind (enum), label,
  // storagePath, contentType nullable, sizeBytes bigint nullable, uploadedById
  // nullable, createdAt). kind is the app's CHECK enum.
  DealDocument: defineTable({
    id: v.string(),
    dealId: v.string(),
    spaceId: v.string(),
    kind: v.union(
      v.literal('offer'),
      v.literal('counter_offer'),
      v.literal('purchase_agreement'),
      v.literal('inspection_report'),
      v.literal('appraisal'),
      v.literal('loan_estimate'),
      v.literal('closing_disclosure'),
      v.literal('title_commitment'),
      v.literal('photo'),
      v.literal('other'),
    ),
    label: v.string(),
    storagePath: v.string(),
    contentType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()), // bigint (counts/bytes, NOT cents)
    uploadedById: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
  })
    // Per-doc GET/DELETE by id (+ dealId + spaceId scope; packet doc serve).
    .index('by_app_id', ['id'])
    // idx_deal_document_deal (dealId, createdAt DESC): a deal's documents
    // newest-first (documents GET, deal detail, contact-detail by `.in('dealId')`,
    // deal delete storage cleanup). spaceId asserted in-handler.
    .index('by_deal_created', ['dealId', 'createdAt'])
    // packets validate + storage-gc reference-check by storagePath
    // (`.in('storagePath', candidates)` / `.in('id', includeIds)`).
    .index('by_storage_path', ['storagePath']),

  // Was: "DealReviewRequest" (TEXT id, dealId, requestingUserId, companyId,
  // status default 'open' (enum), reason, createdAt, resolvedAt nullable,
  // resolvedByUserId nullable, resolvedNote nullable).
  DealReviewRequest: defineTable({
    id: v.string(),
    dealId: v.string(),
    requestingUserId: v.string(),
    companyId: v.string(),
    status: v.union(v.literal('open'), v.literal('approved'), v.literal('closed')),
    reason: v.string(),
    createdAt: v.string(), // ISO-8601
    resolvedAt: v.optional(v.string()),
    resolvedByUserId: v.optional(v.string()),
    resolvedNote: v.optional(v.string()),
  })
    // GET/PATCH a request by id (manager reviews detail, comments POST guard,
    // space reviews detail).
    .index('by_app_id', ['id'])
    // idx_dealreview_company_status (companyId, status): the company review queue
    // (manager reviews list, status filtered in-handler when not 'all').
    .index('by_company_status', ['companyId', 'status'])
    // idx_dealreview_deal (dealId) + the UNIQUE(dealId) WHERE status='open'
    // invariant: the "one open per deal" pre-check in request-deal-review reads
    // this then inserts only if none open. Also the per-deal request lookup.
    .index('by_deal_status', ['dealId', 'status'])
    // space reviews list filters by (requestingUserId, companyId).
    .index('by_requesting_user', ['requestingUserId']),

  // Was: "DealReviewComment" (TEXT id, reviewRequestId, authorUserId, body,
  // createdAt). The review thread.
  DealReviewComment: defineTable({
    id: v.string(),
    reviewRequestId: v.string(),
    authorUserId: v.string(),
    body: v.string(),
    createdAt: v.string(), // ISO-8601
  })
    // idx_dealreviewcomment_request_created (reviewRequestId, createdAt): a
    // request's comments oldest-first (detail pages) + the count-per-request
    // (`.in('reviewRequestId', ids)`) the list pages fold.
    .index('by_request_created', ['reviewRequestId', 'createdAt']),

  // Was: "DealRoutingRule" (TEXT id, companyId, name, priority int default 100,
  // enabled bool default true, leadType nullable, minBudget numeric(14,2)
  // nullable, maxBudget numeric(14,2) nullable, matchTag nullable,
  // destinationUserId nullable, destinationPoolMethod nullable (enum),
  // destinationPoolTag nullable, createdAt, updatedAt). minBudget/maxBudget are
  // numeric dollar amounts (NOT cents). destinationPoolMethod is the CHECK enum;
  // the destination XOR / budget-range CHECKs are validated in the route, not here.
  DealRoutingRule: defineTable({
    id: v.string(),
    companyId: v.string(),
    name: v.string(),
    priority: v.number(), // integer (default 100)
    enabled: v.boolean(), // default true
    leadType: v.optional(v.string()),
    minBudget: v.optional(v.number()), // numeric(14,2) (NOT cents)
    maxBudget: v.optional(v.number()), // numeric(14,2) (NOT cents)
    matchTag: v.optional(v.string()),
    destinationUserId: v.optional(v.string()),
    destinationPoolMethod: v.optional(
      v.union(v.literal('round_robin'), v.literal('score_based')),
    ),
    destinationPoolTag: v.optional(v.string()),
    createdAt: v.string(), // ISO-8601
    updatedAt: v.string(), // ISO-8601
  })
    // routing-rules PATCH/DELETE key by id (+ companyId scope).
    .index('by_app_id', ['id'])
    // idx_deal_routing_rule_company_priority (companyId, priority, enabled): the
    // ordered rule set for a company (routing-rules GET + settings page +
    // company-routing engine, which also filters enabled=true). enabled folded
    // in-handler so one index serves both the full list and the enabled subset.
    .index('by_company_priority', ['companyId', 'priority', 'enabled']),
};
