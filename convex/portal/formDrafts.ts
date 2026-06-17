import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * FormDraft data access — the Convex replacement for the `.from('FormDraft')`
 * reads & writes in app/api/form-draft/route.ts (save / load) and
 * app/api/form-draft/send-link/route.ts (find a draft to re-email).
 *
 * The resume token (crypto.randomBytes) and the 7-day expiry are computed by the
 * route and passed in — crypto/time math stays in the caller per CONVENTIONS.
 *
 * FormDraft_resumeToken_key UNIQUE(resumeToken): tokens are 256-bit random, so a
 * collision is astronomically unlikely; the create mutation does not re-roll, it
 * just inserts (matching the route, which never handled a token collision).
 */

/** The "load by resume token" SELECT shape: id, answers, currentStep,
 *  formConfigVersion, spaceId, completedAt, expiresAt. Surfaces id, coerces
 *  absent optionals to SQL NULL. The route checks expiry/completedAt itself. */
function toLoadRow(d: {
  id: string;
  answers: unknown;
  currentStep: number;
  formConfigVersion?: number;
  spaceId: string;
  completedAt?: string;
  expiresAt: string;
}) {
  return {
    id: d.id,
    answers: d.answers ?? {},
    currentStep: d.currentStep,
    formConfigVersion: d.formConfigVersion ?? null,
    spaceId: d.spaceId,
    completedAt: d.completedAt ?? null,
    expiresAt: d.expiresAt,
  };
}

/**
 * The newest OPEN draft for (spaceId, email): completedAt IS NULL AND
 * expiresAt > now, ordered createdAt desc, limit 1. Returns { id, resumeToken }
 * or null. Covers BOTH the save-flow existing-draft check (which read
 * id/resumeToken/createdAt) and send-link's lookup (id/resumeToken). The lib
 * lowercases the email before calling, matching the stored normalized value.
 */
export const findOpenForEmail = query({
  args: { spaceId: v.string(), email: v.string(), now: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('FormDraft')
      .withIndex('by_space_email', (q) => q.eq('spaceId', args.spaceId).eq('email', args.email))
      .collect();
    const open = rows.filter((d) => d.completedAt == null && d.expiresAt > args.now);
    if (open.length === 0) return null;
    open.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const top = open[0];
    return { id: top.id, resumeToken: top.resumeToken };
  },
});

/** Load a draft by resumeToken (FormDraft_resumeToken_key UNIQUE), or null.
 *  Mirrors `.eq('resumeToken', token).maybeSingle()`. */
export const getByResumeToken = query({
  args: { resumeToken: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query('FormDraft')
      .withIndex('by_resume_token', (q) => q.eq('resumeToken', args.resumeToken))
      .unique();
    return d ? toLoadRow(d) : null;
  },
});

/**
 * Create a new draft. Replaces the save-flow INSERT. answers defaults to {} and
 * currentStep to 0 (PG defaults) when omitted. formConfigVersion null = unset.
 * Returns { id } (the route returns draftId). The route generated resumeToken +
 * expiresAt and passes them in.
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    email: v.string(),
    resumeToken: v.string(),
    answers: v.optional(v.any()),
    currentStep: v.optional(v.number()),
    formConfigVersion: v.union(v.number(), v.null()),
    expiresAt: v.string(),
  },
  handler: async (ctx, args): Promise<{ id: string }> => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await ctx.db.insert('FormDraft', {
      id,
      spaceId: args.spaceId,
      email: args.email,
      resumeToken: args.resumeToken,
      answers: args.answers ?? {},
      currentStep: args.currentStep ?? 0,
      ...(args.formConfigVersion !== null ? { formConfigVersion: args.formConfigVersion } : {}),
      expiresAt: args.expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    return { id };
  },
});

/**
 * Update an existing draft by id (save-flow UPDATE). Always writes answers,
 * currentStep, formConfigVersion (null clears it), and bumps updatedAt;
 * stamps completedAt only when `completed` is true (mirrors the route appending
 * completedAt to the payload). No-op if the row vanished.
 */
export const update = mutation({
  args: {
    id: v.string(),
    answers: v.any(),
    currentStep: v.number(),
    formConfigVersion: v.union(v.number(), v.null()),
    completed: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    const d = await ctx.db
      .query('FormDraft')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!d) return;
    const patch: Record<string, unknown> = {
      answers: args.answers,
      currentStep: args.currentStep,
      formConfigVersion: args.formConfigVersion === null ? undefined : args.formConfigVersion,
      updatedAt: new Date().toISOString(),
    };
    if (args.completed) patch.completedAt = new Date().toISOString();
    await ctx.db.patch(d._id, patch);
  },
});
