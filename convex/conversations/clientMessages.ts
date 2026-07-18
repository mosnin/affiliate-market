import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ClientMessage data access (CLIENT PORTAL) — the Convex replacement for the
 * `.from('ClientMessage')` reads & writes in app/api/contacts/[id]/client-messages
 * (the seller side) and app/api/clients/messages (the client side).
 *
 * The thread for one Contact is read oldest-first; on load each side marks the
 * OTHER side's unread messages read. Sending appends a row whose senderType is
 * 'seller' (seller route) or 'client' (client route). Auth/ownership and the
 * best-effort email notification stay in the routes; this module owns only the
 * table hops. No money here.
 *
 * The PG `.is('readAt', null)` + `.eq('senderType', …)` mark-read filter is
 * applied in memory in markRead (Convex has no partial index; the contactId
 * index narrows the scan to one thread first).
 */

const senderTypeValidator = v.union(v.literal('client'), v.literal('seller'));

type ClientMessageFields = {
  id: string;
  senderType: 'client' | 'seller';
  body: string;
  createdAt: string;
};

/** The portal message row shape both routes select
 *  (`id, senderType, body, createdAt`). */
function toRow(m: ClientMessageFields) {
  return {
    id: m.id,
    senderType: m.senderType,
    body: m.body,
    createdAt: m.createdAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A contact's portal thread, oldest-first. Mirrors
 *  `.from('ClientMessage').eq('contactId').order('createdAt', asc)`. */
export const listForContact = query({
  args: { contactId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ClientMessage')
      .withIndex('by_contact_created', (q) => q.eq('contactId', args.contactId))
      .order('asc')
      .collect();
    return rows.map(toRow);
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Mark a contact's unread messages of one senderType as read (stamp readAt).
 * Mirrors `.update({ readAt }).eq('contactId').eq('senderType', X).is('readAt', null)`:
 *   - the seller route marks senderType='client' read (client→seller messages),
 *   - the client route marks senderType='seller' read (seller→client messages).
 * Only rows with readAt unset are touched, matching `.is('readAt', null)`.
 */
export const markRead = mutation({
  args: { contactId: v.string(), senderType: senderTypeValidator },
  handler: async (ctx, args): Promise<void> => {
    const now = new Date().toISOString();
    const rows = await ctx.db
      .query('ClientMessage')
      .withIndex('by_contact_created', (q) => q.eq('contactId', args.contactId))
      .collect();
    for (const m of rows) {
      if (m.senderType === args.senderType && m.readAt == null) {
        await ctx.db.patch(m._id, { readAt: now });
      }
    }
  },
});

/**
 * Append a message to a contact's thread. Mirrors both routes' single insert
 * (`.insert({ contactId, spaceId, senderType, body })`) — readAt defaults to
 * absent (unread). Returns the row shape both routes select back
 * (`id, senderType, body, createdAt`).
 */
export const send = mutation({
  args: {
    contactId: v.string(),
    spaceId: v.string(),
    senderType: senderTypeValidator,
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = {
      id: crypto.randomUUID(),
      contactId: args.contactId,
      spaceId: args.spaceId,
      senderType: args.senderType,
      body: args.body,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('ClientMessage', doc);
    return toRow(doc);
  },
});
