import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * MessageTemplate data access — the Convex replacement for the Supabase reads/
 * writes in app/api/message-templates/route.ts (GET/POST),
 * app/api/message-templates/[id]/route.ts (PATCH/DELETE), and the three
 * MessageTemplate operations inside app/api/manager/templates/[id]/publish/route.ts
 * (the publish fan-out — that route ALSO touches CompanyTemplate / CompanyMembership
 * / Space, which stay on Supabase; only the MessageTemplate hops move here).
 *
 * Channel-conditional subject handling (subject only for 'email') stays in the
 * route handlers — they already decide it — so these functions store whatever
 * `subject` they're handed.
 */

const channelValidator = v.union(v.literal('sms'), v.literal('email'), v.literal('note'));

/** App columns of a MessageTemplate — the structural shape both a stored Doc and
 *  an insert payload satisfy (so mappers need no _id / cast). */
type TemplateFields = {
  id: string;
  spaceId: string;
  name: string;
  channel: 'sms' | 'email' | 'note';
  subject?: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  sourceTemplateId?: string;
  sourceVersion?: number;
};

/** Full legacy MessageTemplate row (drop _id/_creationTime, surface `id`,
 *  coerce absent optionals to the SQL NULLs callers/clients expect). */
function toRow(t: TemplateFields) {
  return {
    id: t.id,
    spaceId: t.spaceId,
    name: t.name,
    channel: t.channel,
    subject: t.subject ?? null,
    body: t.body,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    sourceTemplateId: t.sourceTemplateId ?? null,
    sourceVersion: t.sourceVersion ?? null,
  };
}

/**
 * A space's templates, newest-updated first. Replaces
 * `.select('*').eq('spaceId', space.id).order('updatedAt', desc)`.
 */
export const listBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('MessageTemplate')
      .withIndex('by_space_updated', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .collect();
    return rows.map(toRow);
  },
});

/**
 * One template by id, scoped to a space, or null. Replaces the `resolve()`
 * helper's `.eq('id', id).eq('spaceId', space.id).maybeSingle()` — the
 * spaceId guard keeps a caller from reaching another space's template by id.
 */
export const getByIdInSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query('MessageTemplate')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!t || t.spaceId !== args.spaceId) return null;
    return toRow(t);
  },
});

/**
 * Create a template. The route mints the id (crypto.randomUUID). PG filled
 * createdAt/updatedAt from `now()` defaults the insert omitted — we set them
 * here. subject/sourceTemplateId/sourceVersion are optional. Returns the row.
 */
export const create = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    name: v.string(),
    channel: channelValidator,
    body: v.string(),
    subject: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: args.id,
      spaceId: args.spaceId,
      name: args.name,
      channel: args.channel,
      body: args.body,
      ...(args.subject !== null ? { subject: args.subject } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('MessageTemplate', doc);
    return toRow(doc); // in-memory doc mirrors the stored row; no read-back
  },
});

/**
 * PATCH a template, scoped to a space. Only the provided fields change;
 * updatedAt always bumps (the route passes it but we own the timestamp here for
 * parity with the other mutations). subject is tri-state: undefined = leave,
 * null = clear, string = set. Returns the updated row, or null if the id isn't
 * in this space (route -> 404).
 */
export const update = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    name: v.optional(v.string()),
    channel: v.optional(channelValidator),
    subject: v.optional(v.union(v.string(), v.null())),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query('MessageTemplate')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!t || t.spaceId !== args.spaceId) return null;

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.channel !== undefined) patch.channel = args.channel;
    if (args.body !== undefined) patch.body = args.body;
    if (args.subject !== undefined) patch.subject = args.subject ? args.subject : undefined;
    await ctx.db.patch(t._id, patch);
    return toRow((await ctx.db.get(t._id))!);
  },
});

/**
 * DELETE a template, scoped to a space. No-op if it isn't this space's. Returns
 * whether a row was removed (the route returns { ok: true } regardless, but the
 * boolean keeps the call honest). Replaces `.delete().eq('id').eq('spaceId')`.
 */
export const deleteByIdInSpace = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    const t = await ctx.db
      .query('MessageTemplate')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!t || t.spaceId !== args.spaceId) return { deleted: false };
    await ctx.db.delete(t._id);
    return { deleted: true };
  },
});

// ── Publish fan-out helpers (manager/templates/[id]/publish) ─────────────────

/** Existing-copy row shape the publish route inspects: it only selects
 *  id/spaceId/sourceTemplateId/sourceVersion. */
function toCopyRow(t: TemplateFields) {
  return {
    id: t.id,
    spaceId: t.spaceId,
    sourceTemplateId: t.sourceTemplateId ?? null,
    sourceVersion: t.sourceVersion ?? null,
  };
}

/**
 * Find MessageTemplate copies that trace back to a source, within a set of
 * target spaces. Replaces
 * `.select('id, spaceId, sourceTemplateId, sourceVersion')
 *  .eq('sourceTemplateId', templateId).in('spaceId', targetSpaceIds)`.
 *
 * by_source_space is (sourceTemplateId, spaceId); we run one indexed read per
 * target space and concat. `spaceIds` is the agents-in-this-company set (small),
 * so this is cheap and avoids a full-table scan + post-filter.
 */
export const findCopiesBySource = query({
  args: { sourceTemplateId: v.string(), spaceIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: ReturnType<typeof toCopyRow>[] = [];
    for (const spaceId of args.spaceIds) {
      const rows = await ctx.db
        .query('MessageTemplate')
        .withIndex('by_source_space', (q) =>
          q.eq('sourceTemplateId', args.sourceTemplateId).eq('spaceId', spaceId),
        )
        .collect();
      for (const r of rows) out.push(toCopyRow(r));
    }
    return out;
  },
});

/**
 * Insert a fresh MessageTemplate copy from a published CompanyTemplate. The PG
 * insert omitted createdAt/updatedAt (now() defaults) and the id (uuid default)
 * — we mint both here. `userId` is in the old insert payload but MessageTemplate
 * has no userId column (it was a harmless extra key Supabase dropped), so it is
 * intentionally NOT stored. Returns { id }.
 */
export const createFromSource = mutation({
  args: {
    spaceId: v.string(),
    name: v.string(),
    channel: channelValidator,
    subject: v.union(v.string(), v.null()),
    body: v.string(),
    sourceTemplateId: v.string(),
    sourceVersion: v.number(),
  },
  handler: async (ctx, args): Promise<{ id: string }> => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await ctx.db.insert('MessageTemplate', {
      id,
      spaceId: args.spaceId,
      name: args.name,
      channel: args.channel,
      ...(args.subject !== null ? { subject: args.subject } : {}),
      body: args.body,
      sourceTemplateId: args.sourceTemplateId,
      sourceVersion: args.sourceVersion,
      createdAt: now,
      updatedAt: now,
    });
    return { id };
  },
});

/**
 * Update an existing copy to a new published version (by row id). Replaces the
 * publish route's `.update({ name, channel, subject, body, sourceVersion,
 * updatedAt }).eq('id', row.id)`. No-op if the row vanished. Returns whether it
 * updated.
 */
export const updateFromSource = mutation({
  args: {
    id: v.string(),
    name: v.string(),
    channel: channelValidator,
    subject: v.union(v.string(), v.null()),
    body: v.string(),
    sourceVersion: v.number(),
  },
  handler: async (ctx, args): Promise<{ updated: boolean }> => {
    const t = await ctx.db
      .query('MessageTemplate')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!t) return { updated: false };
    await ctx.db.patch(t._id, {
      name: args.name,
      channel: args.channel,
      subject: args.subject ?? undefined,
      body: args.body,
      sourceVersion: args.sourceVersion,
      updatedAt: new Date().toISOString(),
    });
    return { updated: true };
  },
});
