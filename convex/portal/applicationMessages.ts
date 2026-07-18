import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ApplicationMessage data access — the Convex replacement for the
 * `.from('ApplicationMessage')` ops in the application thread: the portal view
 * (app/api/applications/portal/route.ts), the seller/applicant message routes
 * (app/api/applications/[id]/message/route.ts, .../portal/message/route.ts), the
 * demo-request + demo-respond auto-messages, and the public status page
 * (app/apply/[slug]/status/page.tsx).
 *
 * senderType is the 'applicant' | 'seller' CHECK enum. content is capped at 2000
 * chars by the route (PG CHECK) — not re-validated here.
 */

const senderTypeValidator = v.union(v.literal('applicant'), v.literal('seller'));

/** The thread-row shape (id, senderType, content, readAt, createdAt). Absent
 *  readAt -> SQL NULL. */
function toRow(m: {
  id: string;
  senderType: 'applicant' | 'seller';
  content: string;
  readAt?: string;
  createdAt: string;
}) {
  return {
    id: m.id,
    senderType: m.senderType,
    content: m.content,
    readAt: m.readAt ?? null,
    createdAt: m.createdAt,
  };
}

/**
 * A contact's full message thread, oldest-first. Mirrors `.select('id,
 * senderType, content, readAt, createdAt').eq('contactId').order('createdAt', asc)`.
 * idx_app_message_contact = (contactId, createdAt). The caller derives the
 * unread-id set (by senderType) from these rows and passes it back to markRead.
 */
export const listForContact = query({
  args: { contactId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ApplicationMessage')
      .withIndex('by_contact_created', (q) => q.eq('contactId', args.contactId))
      .order('asc')
      .collect();
    return rows.map(toRow);
  },
});

/**
 * Insert a message and return its (id, senderType, content, createdAt) — the
 * seller/applicant/demo-request POSTs that select after insert. content is
 * pre-validated/trimmed by the route. readAt starts unset.
 */
export const create = mutation({
  args: {
    contactId: v.string(),
    spaceId: v.string(),
    senderType: senderTypeValidator,
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: crypto.randomUUID(),
      contactId: args.contactId,
      spaceId: args.spaceId,
      senderType: args.senderType,
      content: args.content,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('ApplicationMessage', doc);
    return {
      id: doc.id,
      senderType: doc.senderType,
      content: doc.content,
      createdAt: doc.createdAt,
    };
  },
});

/**
 * Mark a set of a contact's messages read (set readAt=now) — the read-receipt
 * update. Every call site computes the unread-id set from the same contact's
 * thread it just loaded, so we take (contactId, ids) and stamp the matching rows
 * off the by_contact_created index in ONE pass — replacing the PG
 * `.update({ readAt }).in('id', ids)` without needing a per-id lookup. Only rows
 * still unread are stamped (idempotent). No-op on an empty id list.
 */
export const markRead = mutation({
  args: { contactId: v.string(), ids: v.array(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    if (args.ids.length === 0) return;
    const wanted = new Set(args.ids);
    const now = new Date().toISOString();
    const rows = await ctx.db
      .query('ApplicationMessage')
      .withIndex('by_contact_created', (q) => q.eq('contactId', args.contactId))
      .collect();
    for (const m of rows) {
      if (wanted.has(m.id) && m.readAt == null) await ctx.db.patch(m._id, { readAt: now });
    }
  },
});
