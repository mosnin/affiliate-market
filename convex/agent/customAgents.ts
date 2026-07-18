import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * CustomAgent data access — the Convex replacement for the `.from('CustomAgent')`
 * reads & writes: the custom-agents API, the agents pages, and the swarm load.
 *
 * Every list read filters isActive=true (soft-delete via isActive=false). Per-row
 * reads (edit/get) fetch by id and the route scope-checks spaceId afterward — the
 * by-id queries here return the row including spaceId so the caller can do that.
 */

const modelDefault = 'gpt-4o-mini';

function toAgentRow(a: Doc<'CustomAgent'>) {
  return {
    id: a.id,
    spaceId: a.spaceId,
    name: a.name,
    description: a.description ?? null,
    systemPrompt: a.systemPrompt,
    model: a.model,
    capabilities: a.capabilities ?? [],
    isActive: a.isActive,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A space's ACTIVE custom agents, newest-first. Mirrors `.eq('spaceId')
 *  .eq('isActive', true).order('createdAt', desc)`. (The swarm-page variant omits
 *  the order; callers that don't care still get a stable newest-first list.) */
export const listActiveBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('CustomAgent')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const active = rows.filter((a) => a.isActive);
    active.sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
    return active.map(toAgentRow);
  },
});

/** One agent by id (no scope), or null — the edit/detail reads (route scope-checks
 *  spaceId on the returned row). Mirrors `.eq('id').maybeSingle()`. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const a = await ctx.db
      .query('CustomAgent')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return a ? toAgentRow(a) : null;
  },
});

/** Active agents from a set of ids within a space (swarm run load). Mirrors
 *  `.in('id', ids).eq('spaceId').eq('isActive', true)` selecting (id, name,
 *  systemPrompt). One indexed read per id, scope+active filtered. */
export const activeByIdsForSpace = query({
  args: { ids: v.array(v.string()), spaceId: v.string() },
  handler: async (ctx, args) => {
    const out: { id: string; name: string; systemPrompt: string }[] = [];
    const seen = new Set<string>();
    for (const id of args.ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const a = await ctx.db
        .query('CustomAgent')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (a && a.spaceId === args.spaceId && a.isActive) {
        out.push({ id: a.id, name: a.name, systemPrompt: a.systemPrompt });
      }
    }
    return out;
  },
});

// ── Writes ────────────────────────────────────────────────────────────────────

/** Create a custom agent. PG defaults: systemPrompt='', model='gpt-4o-mini',
 *  capabilities=[], isActive=true. Returns the new row. */
export const create = mutation({
  args: {
    spaceId: v.string(),
    name: v.string(),
    description: v.union(v.string(), v.null()),
    systemPrompt: v.optional(v.string()),
    model: v.optional(v.string()),
    capabilities: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      name: args.name,
      ...(args.description !== null ? { description: args.description } : {}),
      systemPrompt: args.systemPrompt ?? '',
      model: args.model ?? modelDefault,
      capabilities: args.capabilities ?? [],
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('CustomAgent', doc);
    return toAgentRow(doc as Doc<'CustomAgent'>);
  },
});

/**
 * Edit a custom agent (PUT) — patches only the provided fields plus updatedAt.
 * The route already scope-checked spaceId via a prior get; we also require it
 * here so the write can't cross spaces. Returns the updated row, or null if the
 * agent isn't in the space.
 */
export const update = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    systemPrompt: v.optional(v.string()),
    model: v.optional(v.string()),
    capabilities: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const a = await ctx.db
      .query('CustomAgent')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!a || a.spaceId !== args.spaceId) return null;

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.description !== undefined) patch.description = args.description ?? undefined;
    if (args.systemPrompt !== undefined) patch.systemPrompt = args.systemPrompt;
    if (args.model !== undefined) patch.model = args.model;
    if (args.capabilities !== undefined) patch.capabilities = args.capabilities;

    await ctx.db.patch(a._id, patch);
    const updated = (await ctx.db.get(a._id))!;
    return toAgentRow(updated);
  },
});

/** Soft-delete a custom agent (DELETE route): isActive=false + updatedAt. Scoped
 *  to (id, spaceId). Returns whether it existed in the space. */
export const deactivate = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const a = await ctx.db
      .query('CustomAgent')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!a || a.spaceId !== args.spaceId) return { ok: false };
    await ctx.db.patch(a._id, { isActive: false, updatedAt: new Date().toISOString() });
    return { ok: true };
  },
});
