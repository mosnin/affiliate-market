import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * CompanyTemplate data access — the company message-template library (~7 call
 * sites in app/api/manager/templates). All access is company-scoped: list a
 * company's templates (updatedAt DESC), load one by id scoped to its company,
 * create, version-bumping patch, publish-stamp, and delete.
 *
 * The cross-domain fan-out in the publish route (writing each seller's personal
 * MessageTemplate) already lives in the support domain on Convex
 * (api.support.templates.*) and stays there — this module only owns the
 * CompanyTemplate source row, including the post-publish stamp.
 */

const categoryValidator = v.union(
  v.literal('follow-up'),
  v.literal('intro'),
  v.literal('closing'),
  v.literal('demo-invite'),
);
const channelValidator = v.union(v.literal('sms'), v.literal('email'), v.literal('note'));

/** The CompanyTemplateRow shape the routes consume (exact column order/nulls). */
function toTemplateRow(t: Doc<'CompanyTemplate'>) {
  return {
    id: t.id,
    companyId: t.companyId,
    name: t.name,
    category: t.category,
    channel: t.channel,
    subject: t.subject ?? null,
    body: t.body,
    version: t.version,
    publishedAt: t.publishedAt ?? null,
    publishedVersion: t.publishedVersion ?? null,
    publishedCount: t.publishedCount,
    createdByUserId: t.createdByUserId ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A company's templates, newest-updated first (idx_company_template_company_
 *  updated = (companyId, updatedAt DESC)). The GET list endpoint. */
export const listByCompany = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CompanyTemplate')
      .withIndex('by_company_updated', (q) => q.eq('companyId', args.companyId))
      .order('desc')
      .collect();
    return rows.map(toTemplateRow);
  },
});

/** One template by id, scoped to its company (PATCH/DELETE/publish load it as
 *  `.eq('id', templateId).eq('companyId', x).maybeSingle()`). null if absent or
 *  cross-company (no existence leak, matching the old two-filter query). */
export const getByIdScoped = query({
  args: { id: v.string(), companyId: v.string() },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query('CompanyTemplate')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!t || t.companyId !== args.companyId) return null;
    return toTemplateRow(t);
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/** Create a template. Mirrors the POST insert: version=1, publishedAt=null,
 *  publishedCount=0, createdByUserId=caller. The route already normalized subject
 *  (null for non-email channels). createdAt/updatedAt default to now(). */
export const create = mutation({
  args: {
    companyId: v.string(),
    name: v.string(),
    category: categoryValidator,
    channel: channelValidator,
    subject: v.union(v.string(), v.null()),
    body: v.string(),
    createdByUserId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      companyId: args.companyId,
      name: args.name,
      category: args.category,
      channel: args.channel,
      ...(args.subject !== null ? { subject: args.subject } : {}),
      body: args.body,
      version: 1,
      publishedCount: 0,
      ...(args.createdByUserId !== null ? { createdByUserId: args.createdByUserId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const _id = await ctx.db.insert('CompanyTemplate', doc);
    const created = (await ctx.db.get(_id))!;
    return toTemplateRow(created);
  },
});

/**
 * Apply a PATCH to a template, scoped to its company. The route computed the
 * field-level diff (only changed content fields, with the version already bumped
 * and updatedAt stamped) and passes the resolved `patch` here. We just write it,
 * scoped to (id, companyId) as the old `.update(patch).eq('id').eq('companyId')`
 * did. `subject` may be null (clearing it). null if absent/cross-company.
 *
 * (The "no-op rejection" + version-bump logic stays in the route — it's request
 * validation over the loaded row, not a DB concern. The route already loads via
 * getByIdScoped, so the row it diffs against is authoritative.)
 */
export const applyPatch = mutation({
  args: {
    id: v.string(),
    companyId: v.string(),
    patch: v.object({
      name: v.optional(v.string()),
      category: v.optional(categoryValidator),
      channel: v.optional(channelValidator),
      subject: v.optional(v.union(v.string(), v.null())),
      body: v.optional(v.string()),
      version: v.optional(v.number()),
      updatedAt: v.string(),
    }),
  },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query('CompanyTemplate')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!t || t.companyId !== args.companyId) return null;
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(args.patch)) {
      if (val !== undefined) patch[k] = val;
    }
    await ctx.db.patch(t._id, patch);
    const updated = (await ctx.db.get(t._id))!;
    return toTemplateRow(updated);
  },
});

/** Stamp a template after a publish run — `.update({ publishedAt,
 *  publishedVersion, publishedCount, updatedAt }).eq('id').eq('companyId')`. The
 *  per-agent MessageTemplate fan-out is done cross-domain (support) before this;
 *  the route passes the final pushed count + version here. No-op if absent/
 *  cross-company. */
export const stampPublished = mutation({
  args: {
    id: v.string(),
    companyId: v.string(),
    publishedAt: v.string(),
    publishedVersion: v.number(),
    publishedCount: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const t = await ctx.db
      .query('CompanyTemplate')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!t || t.companyId !== args.companyId) return;
    await ctx.db.patch(t._id, {
      publishedAt: args.publishedAt,
      publishedVersion: args.publishedVersion,
      publishedCount: args.publishedCount,
      updatedAt: args.publishedAt,
    });
  },
});

/** Delete a template, scoped to its company (`.delete().eq('id').eq('companyId')
 *  .select('id')`). Returns the deleted id or null (the route 404s on null).
 *
 *  Cross-domain note: the old FK MessageTemplate.sourceTemplateId was ON DELETE
 *  SET NULL — agent-local copies degrade to plain templates. That FK lives in the
 *  support domain; the integrator's lib must null those sourceTemplateId refs
 *  there (support domain) if not already handled by that domain's own logic. */
export const deleteByIdScoped = mutation({
  args: { id: v.string(), companyId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const t = await ctx.db
      .query('CompanyTemplate')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!t || t.companyId !== args.companyId) return null;
    await ctx.db.delete(t._id);
    return t.id;
  },
});
