import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * DealReviewRequest + DealReviewComment data access — Convex replacement for the
 * manager deal-review thread (`.from('DealReviewRequest')` /
 * `.from('DealReviewComment')`). Covers request-deal-review tool + review-request
 * route (create), the manager/space review list + detail pages, the resolve
 * (approve/close) PATCH, and the comments thread.
 *
 * UNIQUE invariant preserved: idx_dealreview_open_per_deal UNIQUE(dealId) WHERE
 * status='open' — at most one OPEN request per deal. The create mutation reads
 * by_deal_status for an existing open request and refuses to insert a second
 * (read-then-insert, serializable — the race-safe backstop the partial unique
 * index used to provide). The route's existing open pre-check maps to the
 * `existingOpen` return.
 *
 * The resolve PATCH was a TOCTOU-guarded CAS (`.eq('status','open')` in the
 * UPDATE filter); it becomes the serializable `resolve` mutation that only flips
 * a still-open request.
 *
 * DealReviewComment inserts cascade-delete with their request (DealReviewRequest
 * ON DELETE CASCADE), and the request cascades with its Deal — both handled in
 * deals.deleteById / stages.deleteById.
 */

const statusValidator = v.union(v.literal('open'), v.literal('approved'), v.literal('closed'));

type ReviewFields = {
  id: string;
  dealId: string;
  requestingUserId: string;
  companyId: string;
  status: 'open' | 'approved' | 'closed';
  reason: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedByUserId?: string;
  resolvedNote?: string;
};

function toReviewRow(r: ReviewFields) {
  return {
    id: r.id,
    dealId: r.dealId,
    requestingUserId: r.requestingUserId,
    companyId: r.companyId,
    status: r.status,
    reason: r.reason,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt ?? null,
    resolvedByUserId: r.resolvedByUserId ?? null,
    resolvedNote: r.resolvedNote ?? null,
  };
}

type CommentFields = {
  id: string;
  reviewRequestId: string;
  authorUserId: string;
  body: string;
  createdAt: string;
};

function toCommentRow(c: CommentFields) {
  return {
    id: c.id,
    reviewRequestId: c.reviewRequestId,
    authorUserId: c.authorUserId,
    body: c.body,
    createdAt: c.createdAt,
  };
}

// ── Request reads ────────────────────────────────────────────────────────────

/** One review request by id, or null (manager/space review detail, comments POST
 *  guard). Mirrors `.eq('id').maybeSingle()`. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('DealReviewRequest')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return r ? toReviewRow(r) : null;
  },
});

/** One request by id scoped to a company, or null (manager review detail/PATCH
 *  load). Mirrors `.eq('id').eq('companyId').maybeSingle()`. */
export const getByIdInCompany = query({
  args: { id: v.string(), companyId: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('DealReviewRequest')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.companyId !== args.companyId) return null;
    return toReviewRow(r);
  },
});

/**
 * A company's review requests, optionally status-filtered, newest-first, capped
 * (manager reviews list/queue). Replaces `.eq('companyId')[.eq('status')].order(
 * 'createdAt', desc).limit(200)`. Rides by_company_status; when no status is
 * given (the 'all' filter) it returns every status.
 */
export const listByCompany = query({
  args: { companyId: v.string(), status: v.optional(statusValidator), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows =
      args.status !== undefined
        ? await ctx.db
            .query('DealReviewRequest')
            .withIndex('by_company_status', (q) =>
              q.eq('companyId', args.companyId).eq('status', args.status!),
            )
            .collect()
        : await ctx.db
            .query('DealReviewRequest')
            .withIndex('by_company_status', (q) => q.eq('companyId', args.companyId))
            .collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const capped = rows.slice(0, args.limit ?? 200);
    return capped.map(toReviewRow);
  },
});

/**
 * A user's review requests within a company, optionally status-filtered, newest-
 * first, capped (space /reviews list — the seller's own requests). Replaces
 * `.eq('requestingUserId').eq('companyId')[.eq('status')].order('createdAt',
 * desc).limit(200)`. Rides by_requesting_user, asserts company in-handler.
 */
export const listByRequestingUser = query({
  args: {
    requestingUserId: v.string(),
    companyId: v.string(),
    status: v.optional(statusValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DealReviewRequest')
      .withIndex('by_requesting_user', (q) => q.eq('requestingUserId', args.requestingUserId))
      .collect();
    const filtered = rows.filter(
      (r) =>
        r.companyId === args.companyId &&
        (args.status === undefined || r.status === args.status),
    );
    filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const capped = filtered.slice(0, args.limit ?? 200);
    return capped.map(toReviewRow);
  },
});

/** The open request for a deal, if any (request-deal-review pre-check). Replaces
 *  `.eq('dealId').eq('status','open').maybeSingle()`. */
export const openRequestForDeal = query({
  args: { dealId: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('DealReviewRequest')
      .withIndex('by_deal_status', (q) => q.eq('dealId', args.dealId).eq('status', 'open'))
      .first();
    return r ? toReviewRow(r) : null;
  },
});

// ── Request writes ───────────────────────────────────────────────────────────

export interface CreateReviewResult {
  /** 'created' = a new open request was inserted. 'existingOpen' = a request was
   *  already open for this deal (UNIQUE(dealId) WHERE status='open') — the caller
   *  surfaces the existing one instead of erroring. */
  outcome: 'created' | 'existingOpen';
  request: ReturnType<typeof toReviewRow>;
}

/**
 * Open a review request for a deal (request-deal-review tool, review-request
 * route). status defaults to 'open'. Preserves UNIQUE(dealId) WHERE status='open'
 * by read-then-insert: if an open request already exists it returns that
 * (outcome='existingOpen') rather than inserting a second. Returns the request +
 * the outcome.
 */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    dealId: v.string(),
    requestingUserId: v.string(),
    companyId: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<CreateReviewResult> => {
    const existingOpen = await ctx.db
      .query('DealReviewRequest')
      .withIndex('by_deal_status', (q) => q.eq('dealId', args.dealId).eq('status', 'open'))
      .first();
    if (existingOpen) {
      return { outcome: 'existingOpen', request: toReviewRow(existingOpen) };
    }
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      dealId: args.dealId,
      requestingUserId: args.requestingUserId,
      companyId: args.companyId,
      status: 'open' as const,
      reason: args.reason,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('DealReviewRequest', doc);
    return { outcome: 'created', request: toReviewRow(doc) };
  },
});

/**
 * Resolve a review request (manager reviews PATCH: approve or close), scoped to
 * companyId. This was a TOCTOU-guarded CAS (`.eq('status','open')` in the UPDATE
 * filter); here it only flips a STILL-open request, race-free under
 * serializability. Sets status + resolvedAt + resolvedByUserId + resolvedNote.
 * Returns the updated row on success, or null if the request is missing, the
 * company mismatches, or it was already resolved (lost the CAS).
 */
export const resolve = mutation({
  args: {
    id: v.string(),
    companyId: v.string(),
    status: v.union(v.literal('approved'), v.literal('closed')),
    resolvedByUserId: v.string(),
    resolvedNote: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('DealReviewRequest')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r || r.companyId !== args.companyId || r.status !== 'open') return null;
    await ctx.db.patch(r._id, {
      status: args.status,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: args.resolvedByUserId,
      ...(args.resolvedNote !== null ? { resolvedNote: args.resolvedNote } : {}),
    });
    const updated = (await ctx.db.get(r._id))!;
    return toReviewRow(updated);
  },
});

// ── Comment reads ────────────────────────────────────────────────────────────

/** A request's comments oldest-first (review detail pages). Replaces
 *  `.eq('reviewRequestId', id).order('createdAt', asc)`. Rides
 *  by_request_created. */
export const listCommentsByRequest = query({
  args: { reviewRequestId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DealReviewComment')
      .withIndex('by_request_created', (q) => q.eq('reviewRequestId', args.reviewRequestId))
      .order('asc')
      .collect();
    return rows.map(toCommentRow);
  },
});

/** Comment counts per request (manager/space review list pages: a badge per
 *  request). Replaces `.in('reviewRequestId', reviewIds).select('id,
 *  reviewRequestId')` then a client-side group-count. Returns a map of
 *  reviewRequestId -> count. */
export const countCommentsByRequests = query({
  args: { reviewRequestIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};
    for (const id of args.reviewRequestIds) {
      const rows = await ctx.db
        .query('DealReviewComment')
        .withIndex('by_request_created', (q) => q.eq('reviewRequestId', id))
        .collect();
      counts[id] = rows.length;
    }
    return counts;
  },
});

// ── Comment writes ───────────────────────────────────────────────────────────

/** Append a comment to a review thread (comments POST). Replaces
 *  `.insert({ id, reviewRequestId, authorUserId, body, createdAt })`. Returns the
 *  inserted row. */
export const createComment = mutation({
  args: {
    id: v.optional(v.string()),
    reviewRequestId: v.string(),
    authorUserId: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      reviewRequestId: args.reviewRequestId,
      authorUserId: args.authorUserId,
      body: args.body,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('DealReviewComment', doc);
    return toCommentRow(doc);
  },
});
