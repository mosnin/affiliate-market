import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * AgentDraft data access — the Convex replacement for the ~30 `.from('AgentDraft')`
 * sites: the drafts API (list / patch / feedback / batch-approve / stats /
 * quick-draft / inbound), the cron outcome sweep, and the many pending-count
 * badges + briefing reads (sections, momentum, tips, gmail dedupe, draft-voice).
 *
 * SNAKE_CASE columns are preserved verbatim: feedback_action, edit_distance,
 * decision_ms, outcome_signal, outcome_checked_at. The call sites read those
 * exact keys (draft-stats math, voice sampling) so they must round-trip unchanged.
 *
 * Cross-domain joins (Contact:contactId, the Deal lookups in the outcome cron)
 * STAY IN LIB — Contact/Deal are other domains. These queries return only the
 * AgentDraft columns; the lib hydrates the related rows.
 *
 * The aggregate reads (draft-stats, momentum, tips) return the raw filtered rows
 * so the existing lib math (which is unit-tested) computes the numbers — nothing
 * is recomputed here.
 *
 * UNIQUE(idempotencyKey): no call site sets idempotencyKey today (quick-draft
 * inserts without it, accepting duplicates on retry), so `create` doesn't enforce
 * it. If a future caller passes one, use `createIdempotent` which reads
 * by_idempotency_key first.
 */

const statusValidator = v.union(
  v.literal('pending'),
  v.literal('approved'),
  v.literal('dismissed'),
  v.literal('sent'),
);
const channelValidator = v.union(v.literal('sms'), v.literal('email'), v.literal('note'));
const feedbackActionValidator = v.union(
  v.literal('approved'),
  v.literal('edited_and_approved'),
  v.literal('rejected'),
  v.literal('held'),
);
const outcomeValidator = v.union(
  v.literal('responded'),
  v.literal('no_response'),
  v.literal('bounced'),
  v.literal('unsubscribed'),
  v.literal('meeting_booked'),
);

/** The full AgentDraft row (the list/detail call sites select a superset of
 *  these; the lib picks the columns it needs). Surface `id`, coerce absent
 *  optionals to null, preserve snake_case keys. */
function toDraftRow(d: Doc<'AgentDraft'>) {
  return {
    id: d.id,
    spaceId: d.spaceId,
    contactId: d.contactId ?? null,
    dealId: d.dealId ?? null,
    channel: d.channel,
    subject: d.subject ?? null,
    content: d.content,
    reasoning: d.reasoning ?? null,
    priority: d.priority,
    status: d.status,
    expiresAt: d.expiresAt ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    confidence: d.confidence ?? null,
    outcome: d.outcome ?? null,
    outcomeDetectedAt: d.outcomeDetectedAt ?? null,
    feedback_action: d.feedback_action ?? null,
    edit_distance: d.edit_distance ?? null,
    decision_ms: d.decision_ms ?? null,
    outcome_signal: d.outcome_signal ?? null,
    outcome_checked_at: d.outcome_checked_at ?? null,
    idempotencyKey: d.idempotencyKey ?? null,
    triggerSource: d.triggerSource ?? null,
  };
}

/** (priority desc, createdAt desc) — the list/signal-source ordering. */
function byPriorityThenCreatedDesc(a: Doc<'AgentDraft'>, b: Doc<'AgentDraft'>) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

// ── List / detail reads ───────────────────────────────────────────────────────

/** Drafts for a space in a status, ordered (priority desc, createdAt desc),
 *  capped. Covers the drafts list API and the briefing drafts signal source
 *  (status='pending', limit 10). Returns full rows; the lib joins Contact. */
export const listBySpaceStatus = query({
  args: { spaceId: v.string(), status: statusValidator, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentDraft')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', args.status))
      .collect();
    rows.sort(byPriorityThenCreatedDesc);
    return rows.slice(0, args.limit ?? 50).map(toDraftRow);
  },
});

/** One draft by (id, spaceId), or null — the ownership pre-read before every
 *  patch (PATCH/feedback/batch-approve/quick-draft). Returns the full row so the
 *  caller can read whatever columns it checked (status, contactId, content, …). */
export const getByIdForSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('AgentDraft')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d || d.spaceId !== args.spaceId) return null;
    return toDraftRow(d);
  },
});

/** Drafts for a contact in a space, in a set of statuses, newest-first, capped.
 *  Mirrors the contact-detail read `.eq('spaceId').eq('contactId').in('status',
 *  ['pending','approved']).order('createdAt', desc).limit(10)`. */
export const listForContact = query({
  args: {
    spaceId: v.string(),
    contactId: v.string(),
    statuses: v.array(statusValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const allowed = new Set(args.statuses);
    const rows = await ctx.db
      .query('AgentDraft')
      .withIndex('by_space_contact', (q) =>
        q.eq('spaceId', args.spaceId).eq('contactId', args.contactId),
      )
      .collect();
    const filtered = rows.filter((d) => allowed.has(d.status));
    filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return filtered.slice(0, args.limit ?? 10).map(toDraftRow);
  },
});

// ── Count reads (badges) ──────────────────────────────────────────────────────

/** Count of a space's drafts in a status (default the pending badge). Mirrors
 *  `.select('id', { count:'exact', head:true }).eq('spaceId').eq('status', …)`. */
export const countBySpaceStatus = query({
  args: { spaceId: v.string(), status: statusValidator },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('AgentDraft')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', args.status))
      .collect();
    return rows.length;
  },
});

/** Per-space pending counts for a set of spaces (manager brief/layout: `.in('spaceId',
 *  spaceIds).eq('status','pending')` then grouped by space). Returns the raw
 *  (spaceId) rows so the caller tallies exactly as before. */
export const pendingForSpaces = query({
  args: { spaceIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ spaceId: string }[]> => {
    const out: { spaceId: string }[] = [];
    const seen = new Set<string>();
    for (const sid of args.spaceIds) {
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      const rows = await ctx.db
        .query('AgentDraft')
        .withIndex('by_space_status', (q) => q.eq('spaceId', sid).eq('status', 'pending'))
        .collect();
      for (const r of rows) out.push({ spaceId: r.spaceId });
    }
    return out;
  },
});

/** Count of a space's 'sent' drafts in a [start, end) updatedAt window
 *  (momentum: drafts sent yesterday). Mirrors `.eq('spaceId').eq('status','sent')
 *  .gte('updatedAt', start).lt('updatedAt', end)` with a count head. */
export const countSentInWindow = query({
  args: { spaceId: v.string(), start: v.string(), end: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('AgentDraft')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', 'sent'))
      .collect();
    return rows.filter((d) => d.updatedAt >= args.start && d.updatedAt < args.end).length;
  },
});

// ── Aggregate / window reads (stats, tips, voice, gmail) ──────────────────────

/** Decided drafts (feedback_action IS NOT NULL) for a space since `since`
 *  (draft-stats). Returns (feedback_action, edit_distance, decision_ms,
 *  outcome_signal) — the lib aggregates. Mirrors `.eq('spaceId').not('feedback_action',
 *  'is', null).gte('createdAt', since)`. */
export const decidedStatsForSpace = query({
  args: { spaceId: v.string(), since: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentDraft')
      .withIndex('by_space_feedback', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows
      .filter((d) => d.feedback_action != null && d.createdAt >= args.since)
      .map((d) => ({
        feedback_action: d.feedback_action!,
        edit_distance: d.edit_distance ?? null,
        decision_ms: d.decision_ms ?? null,
        outcome_signal: d.outcome_signal ?? null,
      }));
  },
});

/** Same decided-stats shape, but across a set of spaces (manager brief): `.in('spaceId',
 *  spaceIds).not('feedback_action','is',null).gte('createdAt', since)`. */
export const decidedStatsForSpaces = query({
  args: { spaceIds: v.array(v.string()), since: v.string() },
  handler: async (ctx, args) => {
    const out: {
      feedback_action: string;
      edit_distance: number | null;
      decision_ms: number | null;
      outcome_signal: string | null;
    }[] = [];
    const seen = new Set<string>();
    for (const sid of args.spaceIds) {
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      const rows = await ctx.db
        .query('AgentDraft')
        .withIndex('by_space_feedback', (q) => q.eq('spaceId', sid))
        .collect();
      for (const d of rows) {
        if (d.feedback_action != null && d.createdAt >= args.since) {
          out.push({
            feedback_action: d.feedback_action,
            edit_distance: d.edit_distance ?? null,
            decision_ms: d.decision_ms ?? null,
            outcome_signal: d.outcome_signal ?? null,
          });
        }
      }
    }
    return out;
  },
});

/**
 * Voice samples: a space's email drafts that were edited-then-approved with a
 * meaningful edit, recently. Mirrors draft-voice.getRecentVoiceSamples:
 * `.eq('spaceId').eq('channel','email').eq('feedback_action','edited_and_approved')
 *  .in('status',['sent','approved']).gt('edit_distance', threshold).gte('updatedAt',
 *  cutoff).order('updatedAt', desc).limit(3)` — selecting ONLY subject+content
 * (PII scoping). The handler keeps that minimal projection.
 */
export const voiceSamples = query({
  args: {
    spaceId: v.string(),
    editDistanceThreshold: v.number(),
    cutoff: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentDraft')
      .withIndex('by_space_feedback', (q) =>
        q.eq('spaceId', args.spaceId).eq('feedback_action', 'edited_and_approved'),
      )
      .collect();
    const filtered = rows.filter(
      (d) =>
        d.channel === 'email' &&
        (d.status === 'sent' || d.status === 'approved') &&
        (d.edit_distance ?? 0) > args.editDistanceThreshold &&
        d.updatedAt >= args.cutoff,
    );
    filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return filtered.slice(0, args.limit ?? 3).map((d) => ({
      subject: d.subject ?? null,
      content: d.content,
    }));
  },
});

/** Status-only rows for a space since `since` (summarize-seller tool counts by
 *  status client-side). Mirrors `.select('status').eq('spaceId').gte('createdAt',
 *  since)`. */
export const statusesForSpaceSince = query({
  args: { spaceId: v.string(), since: v.string() },
  handler: async (ctx, args): Promise<{ status: string }[]> => {
    const rows = await ctx.db
      .query('AgentDraft')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId).gte('createdAt', args.since))
      .collect();
    return rows.map((d) => ({ status: d.status }));
  },
});

/** (contactId, createdAt) for a space's 'sent' drafts in [since, before)
 *  (tip reply-rate decline). Mirrors `.eq('spaceId').eq('status','sent')
 *  .gte('createdAt', since).lt('createdAt', before)`. */
export const sentContactWindow = query({
  args: { spaceId: v.string(), since: v.string(), before: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentDraft')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', 'sent'))
      .collect();
    return rows
      .filter((d) => d.createdAt >= args.since && d.createdAt < args.before)
      .map((d) => ({ contactId: d.contactId ?? null, createdAt: d.createdAt }));
  },
});

/** Drafts for a set of contacts in a space since `since` (tip demo-conversion
 *  drop). Mirrors `.eq('spaceId').in('contactId', ids).gte('createdAt', since)`,
 *  selecting (contactId, channel, subject, createdAt). */
export const forContactsSince = query({
  args: { spaceId: v.string(), contactIds: v.array(v.string()), since: v.string() },
  handler: async (ctx, args) => {
    const wanted = new Set(args.contactIds);
    const out: { contactId: string | null; channel: string; subject: string | null; createdAt: string }[] = [];
    for (const cid of wanted) {
      const rows = await ctx.db
        .query('AgentDraft')
        .withIndex('by_space_contact', (q) => q.eq('spaceId', args.spaceId).eq('contactId', cid))
        .collect();
      for (const d of rows) {
        if (d.createdAt >= args.since) {
          out.push({
            contactId: d.contactId ?? null,
            channel: d.channel,
            subject: d.subject ?? null,
            createdAt: d.createdAt,
          });
        }
      }
    }
    return out;
  },
});

/** Distinct contactIds drafted for a space since `since` (gmail dedupe). Mirrors
 *  `.select('contactId').eq('spaceId').gte('createdAt', since).not('contactId',
 *  'is', null)`. Returns the raw contactId list (the lib builds the Set). */
export const recentlyDraftedContactIds = query({
  args: { spaceId: v.string(), since: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const rows = await ctx.db
      .query('AgentDraft')
      .withIndex('by_space_created', (q) => q.eq('spaceId', args.spaceId).gte('createdAt', args.since))
      .collect();
    return rows.map((d) => d.contactId).filter((id): id is string => id != null);
  },
});

/** The outcome-cron candidate pull: 'sent' drafts with outcome_signal NULL in a
 *  [lowerBound, upperBound] updatedAt window, oldest-first, capped. Across ALL
 *  spaces. Mirrors `.eq('status','sent').is('outcome_signal', null).gte('updatedAt',
 *  lower).lte('updatedAt', upper).order('updatedAt', asc).limit(cap)`. Returns
 *  (id, spaceId, dealId, updatedAt) — the lib joins Deal/DealStage to classify. */
export const outcomeCandidates = query({
  args: { lowerBound: v.string(), upperBound: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentDraft')
      .withIndex('by_status_updated', (q) =>
        q.eq('status', 'sent').gte('updatedAt', args.lowerBound).lte('updatedAt', args.upperBound),
      )
      .order('asc')
      .collect();
    return rows
      .filter((d) => d.outcome_signal == null)
      .slice(0, args.limit)
      .map((d) => ({
        id: d.id,
        spaceId: d.spaceId,
        dealId: d.dealId ?? null,
        updatedAt: d.updatedAt,
      }));
  },
});

// ── Writes ────────────────────────────────────────────────────────────────────

/** Insert a draft (quick-draft + any agent draft creation). Mirrors the
 *  quick-draft insert: status defaults 'pending', priority to 0; subject is null
 *  for non-email. Returns the new row (the route selected
 *  id/channel/subject/content/contactId). */
export const create = mutation({
  args: {
    spaceId: v.string(),
    contactId: v.union(v.string(), v.null()),
    dealId: v.union(v.string(), v.null()),
    channel: channelValidator,
    subject: v.union(v.string(), v.null()),
    content: v.string(),
    reasoning: v.union(v.string(), v.null()),
    priority: v.optional(v.number()),
    status: v.optional(statusValidator),
    confidence: v.optional(v.union(v.number(), v.null())),
    expiresAt: v.optional(v.union(v.string(), v.null())),
    triggerSource: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const doc = {
      id,
      spaceId: args.spaceId,
      ...(args.contactId !== null ? { contactId: args.contactId } : {}),
      ...(args.dealId !== null ? { dealId: args.dealId } : {}),
      channel: args.channel,
      ...(args.subject !== null ? { subject: args.subject } : {}),
      content: args.content,
      ...(args.reasoning !== null ? { reasoning: args.reasoning } : {}),
      priority: args.priority ?? 0,
      status: args.status ?? ('pending' as const),
      ...(args.confidence != null ? { confidence: args.confidence } : {}),
      ...(args.expiresAt != null ? { expiresAt: args.expiresAt } : {}),
      ...(args.triggerSource !== undefined ? { triggerSource: args.triggerSource } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('AgentDraft', doc);
    return toDraftRow(doc as Doc<'AgentDraft'>);
  },
});

export interface CreateIdempotentResult {
  draft: ReturnType<typeof toDraftRow>;
  /** true when an existing row matched idempotencyKey (no insert performed). */
  deduped: boolean;
}

/** Idempotent insert keyed on idempotencyKey (UNIQUE). Reads by_idempotency_key
 *  first; if a row exists, returns it without inserting (the race-safe backstop
 *  the old unique index gave). No current caller uses this, but it preserves the
 *  invariant for when one does. */
export const createIdempotent = mutation({
  args: {
    idempotencyKey: v.string(),
    spaceId: v.string(),
    contactId: v.union(v.string(), v.null()),
    dealId: v.union(v.string(), v.null()),
    channel: channelValidator,
    subject: v.union(v.string(), v.null()),
    content: v.string(),
    reasoning: v.union(v.string(), v.null()),
    priority: v.optional(v.number()),
    status: v.optional(statusValidator),
  },
  handler: async (ctx, args): Promise<CreateIdempotentResult> => {
    const existing = await ctx.db
      .query('AgentDraft')
      .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
      .first();
    if (existing) return { draft: toDraftRow(existing), deduped: true };

    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      idempotencyKey: args.idempotencyKey,
      spaceId: args.spaceId,
      ...(args.contactId !== null ? { contactId: args.contactId } : {}),
      ...(args.dealId !== null ? { dealId: args.dealId } : {}),
      channel: args.channel,
      ...(args.subject !== null ? { subject: args.subject } : {}),
      content: args.content,
      ...(args.reasoning !== null ? { reasoning: args.reasoning } : {}),
      priority: args.priority ?? 0,
      status: args.status ?? ('pending' as const),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('AgentDraft', doc);
    return { draft: toDraftRow(doc as Doc<'AgentDraft'>), deduped: false };
  },
});

/**
 * Generic scoped patch by (id, spaceId). Covers every AgentDraft update that
 * patches a subset of {status, content, feedback_action, edit_distance,
 * decision_ms, outcome, outcomeDetectedAt, updatedAt}: the approve/dismiss/held
 * feedback patches, batch-approve, quick-draft status flip, and inbound
 * "responded". Only the fields present in `patch` are written (each maps to a
 * column the old route set). Returns the updated row, or null if not in scope.
 */
export const updateForSpace = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    patch: v.object({
      status: v.optional(statusValidator),
      content: v.optional(v.string()),
      feedback_action: v.optional(feedbackActionValidator),
      edit_distance: v.optional(v.number()),
      decision_ms: v.optional(v.number()),
      outcome: v.optional(outcomeValidator),
      outcomeDetectedAt: v.optional(v.string()),
      touchUpdatedAt: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('AgentDraft')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d || d.spaceId !== args.spaceId) return null;

    const p = args.patch;
    const patch: Record<string, unknown> = {};
    if (p.status !== undefined) patch.status = p.status;
    if (p.content !== undefined) patch.content = p.content;
    if (p.feedback_action !== undefined) patch.feedback_action = p.feedback_action;
    if (p.edit_distance !== undefined) patch.edit_distance = p.edit_distance;
    if (p.decision_ms !== undefined) patch.decision_ms = p.decision_ms;
    if (p.outcome !== undefined) patch.outcome = p.outcome;
    if (p.outcomeDetectedAt !== undefined) patch.outcomeDetectedAt = p.outcomeDetectedAt;
    // The old routes set updatedAt on status flips (not on the held/feedback-only
    // patch). Caller opts in via touchUpdatedAt.
    if (p.touchUpdatedAt) patch.updatedAt = new Date().toISOString();

    await ctx.db.patch(d._id, patch);
    const updated = (await ctx.db.get(d._id))!;
    return toDraftRow(updated);
  },
});

/**
 * The outcome-cron per-draft label write with the `.is('outcome_signal', null)`
 * race guard: only sets outcome_signal + outcome_checked_at if the row is still
 * unlabelled (so concurrent cron runs don't clobber). Mirrors
 * `.update({outcome_signal, outcome_checked_at}).eq('id', draftId).is('outcome_signal', null)`.
 * Returns whether the write landed.
 */
export const labelOutcome = mutation({
  args: { id: v.string(), outcomeSignal: v.string(), checkedAt: v.string() },
  handler: async (ctx, args): Promise<{ updated: boolean }> => {
    const d = await ctx.db
      .query('AgentDraft')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d) return { updated: false };
    if (d.outcome_signal != null) return { updated: false }; // race guard
    await ctx.db.patch(d._id, {
      outcome_signal: args.outcomeSignal,
      outcome_checked_at: args.checkedAt,
    });
    return { updated: true };
  },
});
