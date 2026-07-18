import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ClientInfoRequest data access — the Convex replacement for the
 * `.from('ClientInfoRequest')` ops in app/api/contacts/[id]/info-request/route.ts
 * (seller creates a request) and app/api/clients/info-request/route.ts (client
 * lists pending + fulfils one). Email notifications stay in the routes.
 */

const statusValidator = v.union(
  v.literal('pending'),
  v.literal('fulfilled'),
  v.literal('dismissed'),
);

/** The row shape both surfaces select: id, message, status, response, createdAt,
 *  fulfilledAt. Absent optionals -> SQL NULL. */
function toRow(r: {
  id: string;
  message: string;
  status: 'pending' | 'fulfilled' | 'dismissed';
  response?: string;
  createdAt: string;
  fulfilledAt?: string;
}) {
  return {
    id: r.id,
    message: r.message,
    status: r.status,
    response: r.response ?? null,
    createdAt: r.createdAt,
    fulfilledAt: r.fulfilledAt ?? null,
  };
}

/**
 * A contact's non-dismissed requests, newest-first — the client portal list.
 * Mirrors `.select(...).eq('contactId').neq('status','dismissed').order('createdAt', desc)`.
 * ClientInfoRequest_contact_idx = (contactId, status); the status filter is
 * applied in memory after the contactId range.
 */
export const listForContact = query({
  args: { contactId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ClientInfoRequest')
      .withIndex('by_contact_created', (q) => q.eq('contactId', args.contactId))
      .order('desc')
      .collect();
    return rows.filter((r) => r.status !== 'dismissed').map(toRow);
  },
});

/**
 * One request's (id, contactId, status, spaceId) by id — the fulfil-flow
 * ownership/state pre-check. Mirrors `.select('id, contactId, status, spaceId')
 * .eq('id').maybeSingle()`. Returns the minimal guard fields or null.
 */
export const getGuardFields = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db
      .query('ClientInfoRequest')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r) return null;
    return { id: r.id, contactId: r.contactId, status: r.status, spaceId: r.spaceId };
  },
});

/**
 * Create a request (seller POST). Replaces `.insert({ contactId, spaceId,
 * message, status:'pending' }).select(ROW).single()`. status defaults to
 * 'pending'. Returns the row.
 */
export const create = mutation({
  args: { contactId: v.string(), spaceId: v.string(), message: v.string() },
  handler: async (ctx, args) => {
    const doc = {
      id: crypto.randomUUID(),
      contactId: args.contactId,
      spaceId: args.spaceId,
      message: args.message,
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert('ClientInfoRequest', doc);
    return toRow(doc);
  },
});

/**
 * Fulfil a request by id (client POST): set response, status='fulfilled',
 * fulfilledAt=now. Mirrors `.update({ response, status:'fulfilled', fulfilledAt })
 * .eq('id')`. The route already verified ownership + that status was 'pending'
 * via getGuardFields; this just writes. No-op if the row vanished.
 */
export const fulfill = mutation({
  args: { id: v.string(), response: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const r = await ctx.db
      .query('ClientInfoRequest')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!r) return;
    await ctx.db.patch(r._id, {
      response: args.response,
      status: 'fulfilled',
      fulfilledAt: new Date().toISOString(),
    });
  },
});
