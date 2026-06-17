import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * ContactActivity data access — the per-contact timeline. Convex replacement for
 * every `.from('ContactActivity')` read & write: the AI tools' audit log inserts,
 * the contact-detail / cards / activity-list reads, the agent inbound/send logs,
 * the contact email log, the merge-persons move, and the manager/briefing
 * response-time + momentum analytics scans.
 *
 * `type` is the WIDE enum shared with DealActivity (note|call|email|meeting|
 * follow_up|stage_change|status_change) — the live code writes status_change /
 * stage_change, so the validator must accept them (the narrow setup.sql CHECK is
 * stale). See convex/schema/contacts.ts.
 *
 * No money, no uniqueness invariant. Append-mostly; the only mutation besides
 * insert is the merge move (re-point contactId), which stays a single mutation.
 * Deletion of a contact's activities is handled by contacts.deleteContact's cascade
 * — not here.
 */

type ActivityFields = {
  id: string;
  contactId: string;
  spaceId: string;
  type: 'note' | 'call' | 'email' | 'meeting' | 'follow_up' | 'stage_change' | 'status_change';
  content?: string;
  metadata?: unknown;
  createdAt: string;
};

/** The raw ContactActivity row shape callers read. Surfaces `id`, coerces absent
 *  optionals → SQL NULL (content/metadata are nullable in PG). */
function toRow(a: ActivityFields) {
  return {
    id: a.id,
    contactId: a.contactId,
    spaceId: a.spaceId,
    type: a.type,
    content: a.content ?? null,
    metadata: a.metadata ?? null,
    createdAt: a.createdAt,
  };
}

const activityTypeValidator = v.union(
  v.literal('note'),
  v.literal('call'),
  v.literal('email'),
  v.literal('meeting'),
  v.literal('follow_up'),
  v.literal('stage_change'),
  v.literal('status_change'),
);

const descByCreated = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * A contact's activities newest-first, paginated/capped. Replaces the timeline
 * reads: GET contacts/[id]/activity (offset/limit), cards (limit 3/5), the
 * contact-detail last-touch (limit 1), find-person/context-enrichment recent
 * (limit 1/3). Optional `type`/`typeIn` filter and a content prefix filter for the
 * agent's `[Agent]%`/`[Outcome]%` / won-deal-note probes (PG `.or(content.like.X)`).
 */
export const listForContact = query({
  args: {
    contactId: v.string(),
    spaceId: v.optional(v.string()),
    type: v.optional(activityTypeValidator),
    typeIn: v.optional(v.array(activityTypeValidator)),
    contentPrefixAny: v.optional(v.array(v.string())), // content startsWith ANY of these
    createdGte: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows = await ctx.db
      .query('ContactActivity')
      .withIndex('by_contact_created', (q) => q.eq('contactId', args.contactId))
      .order('desc')
      .collect();
    if (args.spaceId !== undefined) rows = rows.filter((a) => a.spaceId === args.spaceId);
    if (args.type) rows = rows.filter((a) => a.type === args.type);
    if (args.typeIn && args.typeIn.length) rows = rows.filter((a) => args.typeIn!.includes(a.type));
    if (args.createdGte !== undefined) rows = rows.filter((a) => a.createdAt >= args.createdGte!);
    if (args.contentPrefixAny && args.contentPrefixAny.length) {
      rows = rows.filter(
        (a) => a.content != null && args.contentPrefixAny!.some((p) => a.content!.startsWith(p)),
      );
    }
    const offset = Math.max(0, args.offset ?? 0);
    const limit = args.limit ?? 100000;
    return rows.slice(offset, offset + limit).map(toRow);
  },
});

/** COUNT of a contact's activities, optional type + createdAt-since (the tip
 *  "deal closing soon, no touch" check `.eq('contactId').gte('createdAt',X)` and
 *  the merge move-count `.eq('contactId').eq('spaceId')`). */
export const countForContact = query({
  args: {
    contactId: v.string(),
    spaceId: v.optional(v.string()),
    type: v.optional(activityTypeValidator),
    createdGte: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<number> => {
    let rows = await ctx.db
      .query('ContactActivity')
      .withIndex('by_contact_created', (q) => q.eq('contactId', args.contactId))
      .collect();
    if (args.spaceId !== undefined) rows = rows.filter((a) => a.spaceId === args.spaceId);
    if (args.type) rows = rows.filter((a) => a.type === args.type);
    if (args.createdGte !== undefined) rows = rows.filter((a) => a.createdAt >= args.createdGte!);
    return rows.length;
  },
});

/**
 * Activities for a SET of contacts (find-quiet-hot last-touch, reply-rate /
 * demo-conversion analytics): PG `.in('contactId',[...]).[eq/in type].gte(createdAt)`.
 * Loops the by_contact index per id, unions, newest-first.
 */
export const listForContacts = query({
  args: {
    contactIds: v.array(v.string()),
    spaceId: v.optional(v.string()),
    typeIn: v.optional(v.array(activityTypeValidator)),
    createdGte: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows: Doc<'ContactActivity'>[] = [];
    for (const contactId of args.contactIds) {
      const part = await ctx.db
        .query('ContactActivity')
        .withIndex('by_contact_created', (q) => q.eq('contactId', contactId))
        .collect();
      rows.push(...part);
    }
    if (args.spaceId !== undefined) rows = rows.filter((a) => a.spaceId === args.spaceId);
    if (args.typeIn && args.typeIn.length) rows = rows.filter((a) => args.typeIn!.includes(a.type));
    if (args.createdGte !== undefined) rows = rows.filter((a) => a.createdAt >= args.createdGte!);
    rows.sort(descByCreated);
    return rows.slice(0, args.limit ?? 100000).map(toRow);
  },
});

/**
 * Space-wide activity scan in a createdAt window (momentum type-tallies, manager
 * morning/sellers response-time): PG `.eq('spaceId').[in type].gte(createdAt).lt`.
 * Runs on by_space_created per space; type filtered in-handler. Returns the minimal
 * rows the callers fold (type, contactId, createdAt) plus id for completeness.
 */
export const listForSpaces = query({
  args: {
    spaceIds: v.array(v.string()),
    typeIn: v.optional(v.array(activityTypeValidator)),
    contactIdIn: v.optional(v.array(v.string())),
    createdGte: v.optional(v.string()),
    createdLt: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows: Doc<'ContactActivity'>[] = [];
    for (const spaceId of args.spaceIds) {
      const part = await ctx.db
        .query('ContactActivity')
        .withIndex('by_space_created', (q) => q.eq('spaceId', spaceId))
        .collect();
      rows.push(...part);
    }
    if (args.typeIn && args.typeIn.length) rows = rows.filter((a) => args.typeIn!.includes(a.type));
    if (args.contactIdIn && args.contactIdIn.length) {
      const ids = new Set(args.contactIdIn);
      rows = rows.filter((a) => ids.has(a.contactId));
    }
    if (args.createdGte !== undefined) rows = rows.filter((a) => a.createdAt >= args.createdGte!);
    if (args.createdLt !== undefined) rows = rows.filter((a) => a.createdAt < args.createdLt!);
    rows.sort(descByCreated);
    return rows.slice(0, args.limit ?? 100000).map((a) => ({
      id: a.id,
      contactId: a.contactId,
      spaceId: a.spaceId,
      type: a.type,
      content: a.content ?? null,
      createdAt: a.createdAt,
    }));
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Append a timeline entry. Covers every `.from('ContactActivity').insert(...)`:
 * the AI tools' audit logs (note/call/email/meeting/follow_up/status_change), the
 * agent send/inbound logs, the contact email log, the demo state-change logs.
 * Generates id when absent (the activity route passes a UUID; tools pass their own).
 * Returns the inserted row.
 */
export const create = mutation({
  args: {
    contactId: v.string(),
    spaceId: v.string(),
    type: activityTypeValidator,
    content: v.optional(v.union(v.string(), v.null())),
    metadata: v.optional(v.any()),
    id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      contactId: args.contactId,
      spaceId: args.spaceId,
      type: args.type,
      ...(args.content !== undefined && args.content !== null ? { content: args.content } : {}),
      ...(args.metadata !== undefined && args.metadata !== null ? { metadata: args.metadata } : {}),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('ContactActivity', doc);
    return toRow(doc as ActivityFields);
  },
});

/**
 * Move all of one contact's activities to another contact (merge-persons step 1):
 * `.from('ContactActivity').update({contactId: keepId}).eq('contactId', mergeId)
 * .eq('spaceId', X)`. One serializable mutation. Returns the number moved.
 */
export const moveToContact = mutation({
  args: { fromContactId: v.string(), toContactId: v.string(), spaceId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('ContactActivity')
      .withIndex('by_contact_created', (q) => q.eq('contactId', args.fromContactId))
      .collect();
    let moved = 0;
    for (const a of rows) {
      if (args.spaceId !== undefined && a.spaceId !== args.spaceId) continue;
      await ctx.db.patch(a._id, { contactId: args.toContactId });
      moved++;
    }
    return moved;
  },
});
