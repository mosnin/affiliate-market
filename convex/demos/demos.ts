import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * Demo data access — Convex replacement for every Supabase read/write of the
 * "Demo" table (the booking record). Mirrors the call sites in app/api/demos/*,
 * the AI demo tools (schedule/cancel/reschedule/find/merge), the briefing/
 * analytics/portal lib readers, and the cross-cutting routes (mcp, search,
 * notifications, cards, products, today, realtime, manager activity, admin).
 *
 * Cross-domain hops (Contact, ContactActivity, Deal, DealStage, SpaceSetting,
 * Space, GoogleCalendarToken) stay in their callers — only the Demo-table hop
 * moves here, matching the conventions' "each module swaps only its own tables".
 *
 * The plpgsql book_demo_atomic function (lock overlapping demos, count
 * conflicts, insert iff none) collapses into the single serializable `book`
 * mutation below. The portal compare-and-swap status flip becomes `casStatus`.
 */

const statusValidator = v.union(
  v.literal('scheduled'),
  v.literal('confirmed'),
  v.literal('completed'),
  v.literal('cancelled'),
  v.literal('no_show'),
);

/** App columns of a Demo — the shape both a stored Doc and a freshly-built
 *  insert payload satisfy, so the mapper needs no _id stripping/casts. */
type DemoFields = {
  id: string;
  spaceId: string;
  contactId?: string;
  productProfileId?: string;
  guestName: string;
  guestEmail: string;
  guestPhone?: string;
  productAddress?: string;
  notes?: string;
  startsAt: string;
  endsAt: string;
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  googleEventId?: string;
  manageToken?: string;
  createdAt: string;
  updatedAt: string;
  productId?: string;
};

/** Full Demo row in the legacy shape: drop _id/_creationTime, surface `id`,
 *  coerce absent optionals back to the SQL NULLs callers expect. `select('*')`
 *  call sites get this exact column set. */
function toRow(d: DemoFields) {
  return {
    id: d.id,
    spaceId: d.spaceId,
    contactId: d.contactId ?? null,
    productProfileId: d.productProfileId ?? null,
    guestName: d.guestName,
    guestEmail: d.guestEmail,
    guestPhone: d.guestPhone ?? null,
    productAddress: d.productAddress ?? null,
    notes: d.notes ?? null,
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    status: d.status,
    googleEventId: d.googleEventId ?? null,
    manageToken: d.manageToken ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    productId: d.productId ?? null,
  };
}

/** Two demos overlap when one starts before the other ends and vice versa. */
function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && aEnd > bStart;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** A demo by id, or null. Replaces the bare `.eq('id').maybeSingle()` reads
 *  (resolveDemo, prep, gcal sync, portal respond) where the caller does its own
 *  space-ownership check after. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('Demo')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return doc ? toRow(doc) : null;
  },
});

/** A demo by id scoped to a space, or null. Replaces the
 *  `.eq('id').eq('spaceId').maybeSingle()` reads (convert, cards, cancel/
 *  reschedule tools). */
export const getByIdInSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('Demo')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc || doc.spaceId !== args.spaceId) return null;
    return toRow(doc);
  },
});

/** A demo by its manage token, or null. Replaces `.eq('manageToken').
 *  maybeSingle()` (feedback POST, manage cancel, demo-manage page). */
export const getByManageToken = query({
  args: { manageToken: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('Demo')
      .withIndex('by_manage_token', (q) => q.eq('manageToken', args.manageToken))
      .unique();
    return doc ? toRow(doc) : null;
  },
});

/**
 * A space's demos with optional status / startsAt-range / product filters,
 * ordered by startsAt. The flexible workhorse that replaces the many
 * `.from('Demo').select(...).eq('spaceId',...)` reads (list GET, available,
 * today, realtime, find_demos, list_demos, notifications, search base,
 * analytics, calendar signals, briefing).
 *
 * Runs on by_space_starts: equality on spaceId, then the startsAt bound becomes
 * the index range when provided. status/productProfileId/productId are filtered
 * in-handler (small, space-scoped result sets) to keep one index serving every
 * caller. `order` defaults to ascending startsAt; pass 'desc' for newest-first.
 */
export const listBySpace = query({
  args: {
    spaceId: v.string(),
    statuses: v.optional(v.array(statusValidator)),
    startsAtGte: v.optional(v.string()),
    startsAtGt: v.optional(v.string()),
    startsAtLte: v.optional(v.string()),
    startsAtLt: v.optional(v.string()),
    productProfileId: v.optional(v.string()),
    productId: v.optional(v.string()),
    order: v.optional(v.union(v.literal('asc'), v.literal('desc'))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Demo')
      .withIndex('by_space_starts', (q) => {
        // Convex range builders are a state machine: equality, then at most one
        // lower bound (gte|gt), then at most one upper bound (lte|lt). The
        // gte/gt and lte/lt args are mutually exclusive per call, so chain the
        // bounds rather than reassign a single var (which unions the builder
        // states and breaks typing).
        const base = q.eq('spaceId', args.spaceId);
        const lower =
          args.startsAtGte !== undefined
            ? base.gte('startsAt', args.startsAtGte)
            : args.startsAtGt !== undefined
              ? base.gt('startsAt', args.startsAtGt)
              : base;
        return args.startsAtLte !== undefined
          ? lower.lte('startsAt', args.startsAtLte)
          : args.startsAtLt !== undefined
            ? lower.lt('startsAt', args.startsAtLt)
            : lower;
      })
      .order(args.order === 'desc' ? 'desc' : 'asc')
      .collect();

    const statusSet = args.statuses ? new Set(args.statuses) : null;
    const filtered = rows.filter((d) => {
      if (statusSet && !statusSet.has(d.status)) return false;
      if (args.productProfileId !== undefined && d.productProfileId !== args.productProfileId) return false;
      if (args.productId !== undefined && d.productId !== args.productId) return false;
      return true;
    });
    const capped = args.limit !== undefined ? filtered.slice(0, args.limit) : filtered;
    return capped.map(toRow);
  },
});

/**
 * A space's demos whose product matches `productId`, newest-first. Replaces the
 * `.eq('productId').eq('spaceId').order('startsAt', desc)` reads (products/[id]
 * API + seller product page). Rides by_product, then asserts spaceId.
 */
export const listByProduct = query({
  args: { productId: v.string(), spaceId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Demo')
      .withIndex('by_product', (q) => q.eq('productId', args.productId))
      .order('desc')
      .collect();
    const scoped = rows.filter((d) => d.spaceId === args.spaceId);
    const capped = args.limit !== undefined ? scoped.slice(0, args.limit) : scoped;
    return capped.map(toRow);
  },
});

/**
 * A contact's demos, optionally filtered by status, ordered by startsAt.
 * Replaces the `.eq('contactId',...)` reads (contact timeline, contact page,
 * portal + apply status). spaceId, when given, is asserted after the index
 * (contactId is 1:1 with a space). `order` defaults to ascending.
 */
export const listByContact = query({
  args: {
    contactId: v.string(),
    spaceId: v.optional(v.string()),
    statuses: v.optional(v.array(statusValidator)),
    order: v.optional(v.union(v.literal('asc'), v.literal('desc'))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Demo')
      .withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
      .order(args.order === 'desc' ? 'desc' : 'asc')
      .collect();
    const statusSet = args.statuses ? new Set(args.statuses) : null;
    const filtered = rows.filter((d) => {
      if (args.spaceId !== undefined && d.spaceId !== args.spaceId) return false;
      if (statusSet && !statusSet.has(d.status)) return false;
      return true;
    });
    const capped = args.limit !== undefined ? filtered.slice(0, args.limit) : filtered;
    return capped.map(toRow);
  },
});

/**
 * Count a contact's demos in given statuses, optionally excluding one id.
 * Replaces the prep route's `.eq('contactId').in('status', [...]).neq('id', id)`
 * head count and merge_persons' `.eq('contactId')` count.
 */
export const countByContact = query({
  args: {
    contactId: v.string(),
    spaceId: v.optional(v.string()),
    statuses: v.optional(v.array(statusValidator)),
    excludeId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Demo')
      .withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
      .collect();
    const statusSet = args.statuses ? new Set(args.statuses) : null;
    let n = 0;
    for (const d of rows) {
      if (args.spaceId !== undefined && d.spaceId !== args.spaceId) continue;
      if (statusSet && !statusSet.has(d.status)) continue;
      if (args.excludeId !== undefined && d.id === args.excludeId) continue;
      n++;
    }
    return n;
  },
});

/**
 * Cross-space demos starting in a window, optionally filtered by status,
 * ordered by startsAt. Replaces the reminder cron's status+startsAt-range read
 * (no spaceId filter). Rides by_starts; status filtered in-handler.
 */
export const listByStartsRange = query({
  args: {
    statuses: v.optional(v.array(statusValidator)),
    startsAtGte: v.optional(v.string()),
    startsAtLte: v.optional(v.string()),
    order: v.optional(v.union(v.literal('asc'), v.literal('desc'))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Demo')
      .withIndex('by_starts', (q) => {
        const lower = args.startsAtGte !== undefined ? q.gte('startsAt', args.startsAtGte) : q;
        return args.startsAtLte !== undefined ? lower.lte('startsAt', args.startsAtLte) : lower;
      })
      .order(args.order === 'desc' ? 'desc' : 'asc')
      .collect();
    const statusSet = args.statuses ? new Set(args.statuses) : null;
    const filtered = statusSet ? rows.filter((d) => statusSet.has(d.status)) : rows;
    const capped = args.limit !== undefined ? filtered.slice(0, args.limit) : filtered;
    return capped.map(toRow);
  },
});

/**
 * Substring search over a space's demos (guestName / guestEmail / productAddress),
 * case-insensitive, capped. Replaces the search route's
 * `.or('guestName.ilike.%term%, guestEmail.ilike.%term%, productAddress.ilike.%term%')`.
 * `term` is the raw needle (no SQL wildcards) — the route passed `%term%`; here
 * we match it as a lowercased substring.
 */
export const searchBySpace = query({
  args: { spaceId: v.string(), term: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const needle = args.term.trim().toLowerCase();
    const rows = await ctx.db
      .query('Demo')
      .withIndex('by_space_starts', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const matched = needle
      ? rows.filter(
          (d) =>
            d.guestName.toLowerCase().includes(needle) ||
            d.guestEmail.toLowerCase().includes(needle) ||
            (d.productAddress ?? '').toLowerCase().includes(needle),
        )
      : rows;
    return matched.slice(0, args.limit ?? 8).map(toRow);
  },
});

/**
 * Demos whose guestEmail matches (case-insensitive), across all spaces, ordered
 * by startsAt. Replaces the client-portal `.ilike('guestEmail', lower)` read.
 * Scans by_starts and filters by email (the portal is a low-traffic, email-
 * keyed lookup; volume per email is tiny). `order` defaults to descending.
 */
export const listByGuestEmail = query({
  args: { guestEmail: v.string(), order: v.optional(v.union(v.literal('asc'), v.literal('desc'))) },
  handler: async (ctx, args) => {
    const lower = args.guestEmail.trim().toLowerCase();
    const rows = await ctx.db
      .query('Demo')
      .withIndex('by_starts')
      .order(args.order === 'asc' ? 'asc' : 'desc')
      .collect();
    return rows.filter((d) => d.guestEmail.toLowerCase() === lower).map(toRow);
  },
});

/**
 * Every demo's spaceId (capped). Replaces the admin metrics
 * `.from('Demo').select('spaceId').limit(1000)` — the caller dedupes spaceIds
 * to count spaces-with-demos. Returns just spaceId to keep the payload lean.
 */
export const listSpaceIds = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query('Demo').take(args.limit ?? 1000);
    return rows.map((d) => ({ spaceId: d.spaceId }));
  },
});

/**
 * The most-recently-created demos across several spaces (manager team-activity
 * feed). Replaces `.from('Demo').select(...).in('spaceId', spaceIds).order(
 * 'createdAt', desc).limit(N)`. Scans each space on by_space_starts, merges,
 * sorts by createdAt desc, and caps — preserving the cross-space createdAt
 * ordering the activity feed needs (no createdAt index exists; team sizes are
 * small so the per-space fan-out is cheap).
 */
export const listBySpaceIdsRecent = query({
  args: { spaceIds: v.array(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const all: DemoFields[] = [];
    for (const spaceId of args.spaceIds) {
      const rows = await ctx.db
        .query('Demo')
        .withIndex('by_space_starts', (q) => q.eq('spaceId', spaceId))
        .collect();
      all.push(...rows);
    }
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return all.slice(0, args.limit ?? 10).map(toRow);
  },
});

/** Total demo count (all spaces). Replaces the admin `count: 'exact', head:true`
 *  read with no filters. */
export const countAll = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('Demo').collect();
    return rows.length;
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Atomic conflict-checked booking — the plpgsql book_demo_atomic, now one
 * serializable mutation. Scans the space's scheduled/confirmed demos for any
 * overlap with [startsAt, endsAt); if none, inserts the row and returns it.
 * Returns null on conflict (the route maps null -> 409). The caller supplies
 * `id` and `manageToken` (it pre-generated them), matching the RPC's params.
 *
 * Because the mutation returns the full inserted row, callers no longer need
 * the follow-up `.select('*').eq('id', demoId)` round-trip the RPC path used.
 */
export const book = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    contactId: v.union(v.string(), v.null()),
    guestName: v.string(),
    guestEmail: v.string(),
    guestPhone: v.union(v.string(), v.null()),
    productAddress: v.union(v.string(), v.null()),
    notes: v.union(v.string(), v.null()),
    startsAt: v.string(),
    endsAt: v.string(),
    productProfileId: v.union(v.string(), v.null()),
    manageToken: v.string(),
  },
  handler: async (ctx, args) => {
    // Overlap scan over the space's active demos (the FOR UPDATE lock + COUNT
    // in the RPC; Convex mutations are serializable so the scan is the lock).
    // Overlap requires d.startsAt < newEnd, so bound the index range there to
    // prune everything starting at/after the new window — then confirm the
    // d.endsAt > newStart half (and the active status) in-process.
    const candidates = await ctx.db
      .query('Demo')
      .withIndex('by_space_starts', (q) =>
        q.eq('spaceId', args.spaceId).lt('startsAt', args.endsAt),
      )
      .collect();
    const conflict = candidates.some(
      (d) =>
        (d.status === 'scheduled' || d.status === 'confirmed') &&
        overlaps(d.startsAt, d.endsAt, args.startsAt, args.endsAt),
    );
    if (conflict) return null; // caller returns 409

    const now = new Date().toISOString();
    const doc = {
      id: args.id,
      spaceId: args.spaceId,
      ...(args.contactId !== null ? { contactId: args.contactId } : {}),
      ...(args.productProfileId !== null ? { productProfileId: args.productProfileId } : {}),
      guestName: args.guestName,
      guestEmail: args.guestEmail,
      ...(args.guestPhone !== null ? { guestPhone: args.guestPhone } : {}),
      ...(args.productAddress !== null ? { productAddress: args.productAddress } : {}),
      ...(args.notes !== null ? { notes: args.notes } : {}),
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      status: 'scheduled' as const,
      manageToken: args.manageToken,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('Demo', doc);
    return toRow(doc);
  },
});

/**
 * Plain insert — no conflict check (the schedule_demo tool inserted directly,
 * unlike the public booking endpoint). status defaults to 'scheduled'. Returns
 * the inserted row so the tool can report id/startsAt/endsAt.
 */
export const create = mutation({
  args: {
    spaceId: v.string(),
    contactId: v.union(v.string(), v.null()),
    guestName: v.string(),
    guestEmail: v.string(),
    guestPhone: v.union(v.string(), v.null()),
    productAddress: v.union(v.string(), v.null()),
    notes: v.union(v.string(), v.null()),
    startsAt: v.string(),
    endsAt: v.string(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      ...(args.contactId !== null ? { contactId: args.contactId } : {}),
      guestName: args.guestName,
      guestEmail: args.guestEmail,
      ...(args.guestPhone !== null ? { guestPhone: args.guestPhone } : {}),
      ...(args.productAddress !== null ? { productAddress: args.productAddress } : {}),
      ...(args.notes !== null ? { notes: args.notes } : {}),
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      status: 'scheduled' as const,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('Demo', doc);
    return toRow(doc);
  },
});

/**
 * Generic owner PATCH (/api/demos/[id]). Applies any provided field, scoped to
 * spaceId so a between-check-and-write reassignment can't cross-tenant the row,
 * always bumping updatedAt. Returns the updated row, or null if the id/space
 * doesn't match (the route throws on a missing row — here null signals that).
 *
 * Tri-state nullable fields (guestPhone/productAddress/notes/contactId): pass a
 * string to set, null to clear (column removed), omit to leave unchanged.
 */
export const updateById = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    status: v.optional(statusValidator),
    guestName: v.optional(v.string()),
    guestEmail: v.optional(v.string()),
    guestPhone: v.optional(v.union(v.string(), v.null())),
    productAddress: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    startsAt: v.optional(v.string()),
    endsAt: v.optional(v.string()),
    contactId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('Demo')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc || doc.spaceId !== args.spaceId) return null;

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.guestName !== undefined) patch.guestName = args.guestName;
    if (args.guestEmail !== undefined) patch.guestEmail = args.guestEmail;
    if (args.guestPhone !== undefined) patch.guestPhone = args.guestPhone ?? undefined;
    if (args.productAddress !== undefined) patch.productAddress = args.productAddress ?? undefined;
    if (args.notes !== undefined) patch.notes = args.notes ?? undefined;
    if (args.startsAt !== undefined) patch.startsAt = args.startsAt;
    if (args.endsAt !== undefined) patch.endsAt = args.endsAt;
    if (args.contactId !== undefined) patch.contactId = args.contactId ?? undefined;

    await ctx.db.patch(doc._id, patch);
    const updated = (await ctx.db.get(doc._id))!;
    return toRow(updated);
  },
});

/**
 * Flip a demo's status (+ updatedAt). Replaces the simple `.update({status})`
 * writes (cancel_demo / reschedule path isn't here — see updateTimes; cancel
 * tool, manage cancel). `spaceId`, when given, scopes the write. No-op (null)
 * if the row/space doesn't match.
 */
export const updateStatus = mutation({
  args: { id: v.string(), spaceId: v.optional(v.string()), status: statusValidator },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('Demo')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc) return null;
    if (args.spaceId !== undefined && doc.spaceId !== args.spaceId) return null;
    await ctx.db.patch(doc._id, { status: args.status, updatedAt: new Date().toISOString() });
    return toRow({ ...doc, status: args.status });
  },
});

/**
 * Compare-and-swap status: only flip to `newStatus` if the row is still in
 * `expectedStatus`, scoped to spaceId. Returns true iff it updated (the portal
 * respond route uses the boolean to decide whether to post the receipt message).
 * This is the Supabase `.eq('id').eq('spaceId').eq('status', expected).select()`
 * CAS, now race-free under Convex serializability.
 */
export const casStatus = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    expectedStatus: statusValidator,
    newStatus: statusValidator,
  },
  handler: async (ctx, args): Promise<boolean> => {
    const doc = await ctx.db
      .query('Demo')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc || doc.spaceId !== args.spaceId || doc.status !== args.expectedStatus) {
      return false;
    }
    await ctx.db.patch(doc._id, { status: args.newStatus, updatedAt: new Date().toISOString() });
    return true;
  },
});

/**
 * Move a demo to a new time window (+ updatedAt), scoped to spaceId. Replaces
 * the reschedule_demo tool's `.update({startsAt, endsAt}).eq('id').eq('spaceId')`.
 * No-op (null) if the row/space doesn't match.
 */
export const updateTimes = mutation({
  args: { id: v.string(), spaceId: v.string(), startsAt: v.string(), endsAt: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('Demo')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc || doc.spaceId !== args.spaceId) return null;
    await ctx.db.patch(doc._id, {
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      updatedAt: new Date().toISOString(),
    });
    return toRow({ ...doc, startsAt: args.startsAt, endsAt: args.endsAt });
  },
});

/**
 * Set or clear the mirrored Google Calendar event id. Replaces the gcal sync
 * route's `.update({ googleEventId }).eq('id')` (set) and the
 * `.update({ googleEventId: null })` (clear-on-stale) writes, plus the cancel
 * tool / PATCH clears. `spaceId`, when given, scopes the write. No read-back —
 * these are fire-and-forget housekeeping.
 */
export const setGoogleEventId = mutation({
  args: {
    id: v.string(),
    spaceId: v.optional(v.string()),
    googleEventId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<void> => {
    const doc = await ctx.db
      .query('Demo')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc) return;
    if (args.spaceId !== undefined && doc.spaceId !== args.spaceId) return;
    await ctx.db.patch(doc._id, { googleEventId: args.googleEventId ?? undefined });
  },
});

/**
 * Link a demo to a contact (convert flow, when the demo had no contactId).
 * Replaces `.update({ contactId }).eq('id')`. No-op if the row is gone.
 */
export const setContactId = mutation({
  args: { id: v.string(), contactId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const doc = await ctx.db
      .query('Demo')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc) return;
    await ctx.db.patch(doc._id, { contactId: args.contactId });
  },
});

/**
 * Re-point every demo from one contact to another within a space (merge_persons
 * step 2). Replaces `.update({ contactId: keepId }).eq('contactId', mergeId)`.
 * Returns the number of rows moved.
 */
export const reassignContact = mutation({
  args: { fromContactId: v.string(), toContactId: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Demo')
      .withIndex('by_contact', (q) => q.eq('contactId', args.fromContactId))
      .collect();
    let moved = 0;
    for (const d of rows) {
      if (d.spaceId !== args.spaceId) continue;
      await ctx.db.patch(d._id, { contactId: args.toContactId });
      moved++;
    }
    return moved;
  },
});

/**
 * Null the productId link on every demo pointing at a product (the cross-backend
 * ON DELETE SET NULL the product DELETE route relies on, now that Demo lives in
 * Convex). Replaces `.from('Demo').update({ productId: null }).eq('productId', id)`.
 * Returns the number of demos unlinked.
 */
export const clearProductId = mutation({
  args: { productId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Demo')
      .withIndex('by_product', (q) => q.eq('productId', args.productId))
      .collect();
    for (const d of rows) {
      await ctx.db.patch(d._id, { productId: undefined });
    }
    return rows.length;
  },
});

/**
 * Hard-delete a demo by id, scoped to spaceId. Replaces the owner DELETE
 * route's `.delete().eq('id').eq('spaceId')` (the route resolved ownership and
 * captured the GCal mirror id first). No-op if the id/space doesn't match.
 */
export const deleteById = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const doc = await ctx.db
      .query('Demo')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!doc || doc.spaceId !== args.spaceId) return;
    await ctx.db.delete(doc._id);
  },
});
