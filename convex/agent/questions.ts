import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * AgentQuestion data access — the Convex replacement for the `.from('AgentQuestion')`
 * reads & writes in the questions API, the applicant-portal demo-request route,
 * and the morning summary count.
 *
 * The Contact:contactId(id,name) join in the list read STAYS IN LIB. The answer
 * guard (status must be 'pending', else 409) is preserved as a read-then-patch
 * inside one mutation.
 */

const questionStatusValidator = v.union(
  v.literal('pending'),
  v.literal('answered'),
  v.literal('expired'),
);

function toQuestionRow(q: Doc<'AgentQuestion'>) {
  return {
    id: q.id,
    spaceId: q.spaceId,
    runId: q.runId,
    agentType: q.agentType,
    question: q.question,
    context: q.context ?? null,
    status: q.status,
    answer: q.answer ?? null,
    answeredAt: q.answeredAt ?? null,
    priority: q.priority,
    contactId: q.contactId ?? null,
    createdAt: q.createdAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A space's questions in a status, ordered (priority desc, createdAt ASC),
 *  capped. Mirrors the questions list query (note: createdAt ascending, unlike
 *  drafts/goals). */
export const listBySpace = query({
  args: { spaceId: v.string(), status: questionStatusValidator, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('AgentQuestion')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', args.status))
      .collect();
    rows.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0; // createdAt ASC
    });
    return rows.slice(0, args.limit ?? 20).map(toQuestionRow);
  },
});

/** One question by (id, spaceId), or null — the answer ownership pre-read. */
export const getByIdForSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const q = await ctx.db
      .query('AgentQuestion')
      .withIndex('by_app_id', (qq) => qq.eq('id', args.id))
      .unique();
    if (!q || q.spaceId !== args.spaceId) return null;
    return toQuestionRow(q);
  },
});

/** Count of a space's pending questions (morning summary). Mirrors
 *  `.select('id', { count:'exact', head:true }).eq('spaceId').eq('status','pending')`. */
export const countPending = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('AgentQuestion')
      .withIndex('by_space_status', (q) => q.eq('spaceId', args.spaceId).eq('status', 'pending'))
      .collect();
    return rows.length;
  },
});

// ── Writes ────────────────────────────────────────────────────────────────────

/** Create a question (status hardcoded 'pending'). Covers the questions POST and
 *  the applicant-portal demo-request insert. runId/agentType default to the
 *  route's values; the caller passes them explicitly. Returns the new row. */
export const create = mutation({
  args: {
    spaceId: v.string(),
    runId: v.string(),
    agentType: v.string(),
    question: v.string(),
    context: v.union(v.string(), v.null()),
    contactId: v.union(v.string(), v.null()),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      runId: args.runId,
      agentType: args.agentType,
      question: args.question,
      ...(args.context !== null ? { context: args.context } : {}),
      ...(args.contactId !== null ? { contactId: args.contactId } : {}),
      status: 'pending' as const,
      priority: args.priority ?? 0,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('AgentQuestion', doc);
    return toQuestionRow(doc as Doc<'AgentQuestion'>);
  },
});

export interface AnswerResult {
  /** 'answered' = flipped pending->answered; 'conflict' = not pending (409);
   *  'not_found' = not in space. */
  outcome: 'answered' | 'conflict' | 'not_found';
  question: ReturnType<typeof toQuestionRow> | null;
}

/**
 * Answer a question (PATCH): requires status 'pending' (else 409 conflict, the
 * idempotent guard), then sets status='answered', answer, answeredAt. Scoped to
 * (id, spaceId) — read-then-patch.
 */
export const answer = mutation({
  args: { id: v.string(), spaceId: v.string(), answer: v.string() },
  handler: async (ctx, args): Promise<AnswerResult> => {
    const q = await ctx.db
      .query('AgentQuestion')
      .withIndex('by_app_id', (qq) => qq.eq('id', args.id))
      .unique();
    if (!q || q.spaceId !== args.spaceId) return { outcome: 'not_found', question: null };
    if (q.status !== 'pending') return { outcome: 'conflict', question: toQuestionRow(q) };
    await ctx.db.patch(q._id, {
      status: 'answered',
      answer: args.answer,
      answeredAt: new Date().toISOString(),
    });
    const updated = (await ctx.db.get(q._id))!;
    return { outcome: 'answered', question: toQuestionRow(updated) };
  },
});
