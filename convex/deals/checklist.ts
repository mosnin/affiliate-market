import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * DealChecklistItem data access — Convex replacement for `.from(
 * 'DealChecklistItem')` reads/writes (checklist GET/POST/PATCH/DELETE, the
 * shift-by-N-days route, stages GET enrich, add-checklist-item tool, account
 * export).
 *
 * `kind` is free text in Postgres (no CHECK), so it stays v.string(). The seed-
 * template path (POST with no custom item) inserts a fixed set of items the
 * route computes from the deal's closeDate; the route passes the already-built
 * rows to createMany. The shift route's per-item date math folds into the single
 * `shiftDueDates` mutation below (no more N PATCH round-trips / partial-failure
 * path — one serializable write).
 */

type ChecklistFields = {
  id: string;
  dealId: string;
  spaceId: string;
  kind: string;
  label: string;
  dueAt?: string;
  completedAt?: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

function toRow(c: ChecklistFields) {
  return {
    id: c.id,
    dealId: c.dealId,
    spaceId: c.spaceId,
    kind: c.kind,
    label: c.label,
    dueAt: c.dueAt ?? null,
    completedAt: c.completedAt ?? null,
    position: c.position,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** A deal's checklist ordered by position (checklist GET, deal detail). Replaces
 *  `.eq('dealId', id).order('position', asc)`. Rides by_deal_position. */
export const listByDeal = query({
  args: { dealId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DealChecklistItem')
      .withIndex('by_deal_position', (q) => q.eq('dealId', args.dealId))
      .order('asc')
      .collect();
    return rows.map(toRow);
  },
});

/** Checklist items across several deals (stages GET enrich: per-deal progress
 *  summary). Replaces `.in('dealId', dealIds).select('dealId, completedAt, dueAt,
 *  label')`. Fans out per deal on by_deal_position. */
export const listByDeals = query({
  args: { dealIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const all: ChecklistFields[] = [];
    for (const dealId of args.dealIds) {
      const rows = await ctx.db
        .query('DealChecklistItem')
        .withIndex('by_deal_position', (q) => q.eq('dealId', dealId))
        .collect();
      all.push(...rows);
    }
    return all.map(toRow);
  },
});

/** Count a deal's checklist items (POST seed-template guard: only seed when the
 *  deal has none). Replaces `.eq('dealId', id).select('*', count exact,
 *  head true)`. */
export const countByDeal = query({
  args: { dealId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('DealChecklistItem')
      .withIndex('by_deal_position', (q) => q.eq('dealId', args.dealId))
      .collect();
    return rows.length;
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────

/** Next position at the end of a deal's checklist (POST single custom item, add-
 *  checklist-item tool). Replaces `.eq('dealId', id).order('position', desc).
 *  limit(1)`. */
export const nextPosition = query({
  args: { dealId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('DealChecklistItem')
      .withIndex('by_deal_position', (q) => q.eq('dealId', args.dealId))
      .order('desc')
      .collect();
    return rows.length > 0 ? rows[0].position + 1 : 0;
  },
});

/** Insert one checklist item (POST single, add-checklist-item tool). Replaces
 *  `.insert({...}).select().single()`. dueAt optional (SQL NULL when omitted).
 *  The caller resolves position first. Returns the inserted row. */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    dealId: v.string(),
    spaceId: v.string(),
    kind: v.string(),
    label: v.string(),
    dueAt: v.union(v.string(), v.null()),
    position: v.number(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      dealId: args.dealId,
      spaceId: args.spaceId,
      kind: args.kind,
      label: args.label,
      ...(args.dueAt !== null ? { dueAt: args.dueAt } : {}),
      position: args.position,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('DealChecklistItem', doc);
    return toRow(doc);
  },
});

/** Seed a deal's checklist from a template — insert several items in one mutation
 *  (POST with no custom item). Replaces `.insert([...]).select()`. The route
 *  computes each item's kind/label/dueAt/position from the deal's closeDate and
 *  passes them in. Returns the inserted rows. */
export const createMany = mutation({
  args: {
    items: v.array(
      v.object({
        id: v.optional(v.string()),
        dealId: v.string(),
        spaceId: v.string(),
        kind: v.string(),
        label: v.string(),
        dueAt: v.union(v.string(), v.null()),
        position: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const out: ReturnType<typeof toRow>[] = [];
    for (const it of args.items) {
      const doc = {
        id: it.id ?? crypto.randomUUID(),
        dealId: it.dealId,
        spaceId: it.spaceId,
        kind: it.kind,
        label: it.label,
        ...(it.dueAt !== null ? { dueAt: it.dueAt } : {}),
        position: it.position,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.db.insert('DealChecklistItem', doc);
      out.push(toRow(doc));
    }
    return out;
  },
});

/**
 * Patch a checklist item (PATCH: completedAt toggle, label, dueAt), scoped to
 * dealId + spaceId, bumping updatedAt. Tri-state completedAt/dueAt/label: a value
 * to set, null to clear, omit to leave. Returns the updated row, or null on
 * mismatch.
 */
export const updateById = mutation({
  args: {
    id: v.string(),
    dealId: v.string(),
    spaceId: v.string(),
    completedAt: v.optional(v.union(v.string(), v.null())),
    label: v.optional(v.string()),
    dueAt: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('DealChecklistItem')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c || c.dealId !== args.dealId || c.spaceId !== args.spaceId) return null;
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.completedAt !== undefined) patch.completedAt = args.completedAt ?? undefined;
    if (args.label !== undefined) patch.label = args.label;
    if (args.dueAt !== undefined) patch.dueAt = args.dueAt ?? undefined;
    await ctx.db.patch(c._id, patch);
    const updated = (await ctx.db.get(c._id))!;
    return toRow(updated);
  },
});

/**
 * Shift every unchecked, dated item on a deal by N days (shift route). Replaces
 * the route's fetch-then-N-PATCH loop with one serializable mutation: it parses
 * each item's dueAt, adds `days*86_400_000`ms, and patches dueAt + updatedAt.
 * Completed items and items without a dueAt are left untouched (matching the
 * `.is('completedAt', null).not('dueAt', is, null)` filter). Returns the count
 * shifted. The route still clamps/validates `days` before calling.
 */
export const shiftDueDates = mutation({
  args: { dealId: v.string(), spaceId: v.string(), days: v.number() },
  handler: async (ctx, args): Promise<number> => {
    if (args.days === 0) return 0;
    const ms = args.days * 86_400_000;
    const now = new Date().toISOString();
    const rows = await ctx.db
      .query('DealChecklistItem')
      .withIndex('by_deal_position', (q) => q.eq('dealId', args.dealId))
      .collect();
    let updated = 0;
    for (const c of rows) {
      if (c.spaceId !== args.spaceId) continue;
      if (c.completedAt != null) continue;
      if (c.dueAt == null) continue;
      const existing = new Date(c.dueAt);
      if (isNaN(existing.getTime())) continue;
      const next = new Date(existing.getTime() + ms).toISOString();
      await ctx.db.patch(c._id, { dueAt: next, updatedAt: now });
      updated++;
    }
    return updated;
  },
});

/** Delete a checklist item by id, scoped to dealId + spaceId (PATCH DELETE).
 *  Replaces `.delete().eq('id').eq('dealId').eq('spaceId')`. Returns true iff
 *  deleted. */
export const deleteById = mutation({
  args: { id: v.string(), dealId: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const c = await ctx.db
      .query('DealChecklistItem')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c || c.dealId !== args.dealId || c.spaceId !== args.spaceId) return false;
    await ctx.db.delete(c._id);
    return true;
  },
});
