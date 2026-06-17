import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ApplicationStatusUpdate data access — the Convex replacement for the
 * `.from('ApplicationStatusUpdate')` ops: the status timeline read (portal route
 * + public status page) and the append-only audit INSERTs (status route,
 * applications/[id]/status route, public/apply intake).
 *
 * These rows are an immutable audit trail — only read + insert, never updated or
 * deleted. fromStatus/note are nullable.
 */

/** The timeline-row shape (id, fromStatus, toStatus, note, createdAt). Absent
 *  fromStatus/note -> SQL NULL. */
function toRow(s: {
  id: string;
  fromStatus?: string;
  toStatus: string;
  note?: string;
  createdAt: string;
}) {
  return {
    id: s.id,
    fromStatus: s.fromStatus ?? null,
    toStatus: s.toStatus,
    note: s.note ?? null,
    createdAt: s.createdAt,
  };
}

/**
 * A contact's status timeline, oldest-first. Mirrors `.select('id, fromStatus,
 * toStatus, note, createdAt').eq('contactId').order('createdAt', asc)`.
 * idx_app_status_update_contact = (contactId, createdAt).
 */
export const listForContact = query({
  args: { contactId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ApplicationStatusUpdate')
      .withIndex('by_contact_created', (q) => q.eq('contactId', args.contactId))
      .order('asc')
      .collect();
    return rows.map(toRow);
  },
});

/**
 * Append a status-change audit row. Replaces `.insert({ contactId, spaceId,
 * fromStatus, toStatus, note })` (fire-and-forget at every call site). fromStatus
 * and note are tri-state — null = unset (e.g. the initial 'received' row on a new
 * application has fromStatus=null, note=null). No return value (callers ignore it).
 */
export const create = mutation({
  args: {
    contactId: v.string(),
    spaceId: v.string(),
    fromStatus: v.union(v.string(), v.null()),
    toStatus: v.string(),
    note: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('ApplicationStatusUpdate', {
      id: crypto.randomUUID(),
      contactId: args.contactId,
      spaceId: args.spaceId,
      ...(args.fromStatus !== null ? { fromStatus: args.fromStatus } : {}),
      toStatus: args.toStatus,
      ...(args.note !== null ? { note: args.note } : {}),
      createdAt: new Date().toISOString(),
    });
  },
});
