import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * DealContact data access — Convex replacement for `.from('DealContact')`
 * reads/writes. DealContact is the Deal<->Contact join with a COMPOSITE PK
 * (dealId, contactId) and no surrogate id / timestamps. We mirror that exactly
 * and enforce the composite PK (one row per pair) via read-then-insert inside the
 * link mutations (serializable in Convex — the unique-index dance the old upserts
 * needed is gone).
 *
 * The join's other side (Contact) lives in another domain; every call site that
 * reads `Contact(...)` joined data fetches the Contact rows separately (its own
 * module) using the contactIds these reads return. This module returns the join
 * rows (dealId, contactId, role) only.
 *
 * Postgres ON DELETE CASCADE removes a DealContact when either its Deal or its
 * Contact is deleted. Deal deletes cascade here (deals.deleteById); Contact
 * deletes are driven from the contacts domain — `deleteByContact` below is the
 * hook that flow calls.
 */

const roleValidator = v.union(
  v.literal('buyer'),
  v.literal('seller'),
  v.literal('buyer_agent'),
  v.literal('listing_agent'),
  v.literal('co_agent'),
  v.literal('lender'),
  v.literal('title'),
  v.literal('escrow'),
  v.literal('inspector'),
  v.literal('appraiser'),
  v.literal('attorney'),
  v.literal('other'),
);

type DealContactFields = {
  dealId: string;
  contactId: string;
  role?:
    | 'buyer'
    | 'seller'
    | 'buyer_agent'
    | 'listing_agent'
    | 'co_agent'
    | 'lender'
    | 'title'
    | 'escrow'
    | 'inspector'
    | 'appraiser'
    | 'attorney'
    | 'other';
};

function toRow(dc: DealContactFields) {
  return { dealId: dc.dealId, contactId: dc.contactId, role: dc.role ?? null };
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** A deal's contact links (deal detail, card, stages GET enrich, deal-update
 *  membership diff). Replaces `.from('DealContact').select('contactId[, role]').
 *  eq('dealId', id)`. Returns (dealId, contactId, role). */
export const listByDeal = query({
  args: { dealId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DealContact')
      .withIndex('by_deal', (q) => q.eq('dealId', args.dealId))
      .collect();
    return rows.map(toRow);
  },
});

/** Contact links for several deals (deals GET / stages GET enrich, where the list
 *  decorates each deal with its contacts). Replaces `.in('dealId', dealIds)`.
 *  Fans out per deal on by_deal. */
export const listByDeals = query({
  args: { dealIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const all: DealContactFields[] = [];
    for (const dealId of args.dealIds) {
      const rows = await ctx.db
        .query('DealContact')
        .withIndex('by_deal', (q) => q.eq('dealId', dealId))
        .collect();
      all.push(...rows);
    }
    return all.map(toRow);
  },
});

/** A contact's deal links (contact detail/timeline, find-person/find-deal enrich,
 *  merge-persons, lead unassign/delete). Replaces `.eq('contactId', id)` (and the
 *  count variant). Returns (dealId, contactId, role). */
export const listByContact = query({
  args: { contactId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('DealContact')
      .withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
      .collect();
    return rows.map(toRow);
  },
});

/** Count a contact's deal links (merge-persons "how many deals to move?"
 *  head count). Replaces `.eq('contactId', id).select('dealId', count exact)`. */
export const countByContact = query({
  args: { contactId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('DealContact')
      .withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
      .collect();
    return rows.length;
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Link contacts to a deal (deals POST/PATCH add, demos convert, create-deal).
 * Replaces `.insert([{ dealId, contactId }, ...])`. Enforces the composite PK by
 * skipping pairs that already exist (read-then-insert; serializable). Returns the
 * rows that were newly inserted.
 */
export const addContacts = mutation({
  args: { dealId: v.string(), contactIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('DealContact')
      .withIndex('by_deal', (q) => q.eq('dealId', args.dealId))
      .collect();
    const have = new Set(existing.map((dc) => dc.contactId));
    const inserted: DealContactFields[] = [];
    for (const contactId of args.contactIds) {
      if (have.has(contactId)) continue;
      const doc = { dealId: args.dealId, contactId };
      await ctx.db.insert('DealContact', doc);
      have.add(contactId);
      inserted.push(doc);
    }
    return inserted.map(toRow);
  },
});

/**
 * Remove specific contact links from a deal (deals PATCH membership diff).
 * Replaces `.delete().eq('dealId', id).in('contactId', toRemove)`. Returns the
 * count removed.
 */
export const removeContacts = mutation({
  args: { dealId: v.string(), contactIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    const remove = new Set(args.contactIds);
    const rows = await ctx.db
      .query('DealContact')
      .withIndex('by_deal', (q) => q.eq('dealId', args.dealId))
      .collect();
    let n = 0;
    for (const dc of rows) {
      if (remove.has(dc.contactId)) {
        await ctx.db.delete(dc._id);
        n++;
      }
    }
    return n;
  },
});

/**
 * Patch a single link's role (deals/[id]/contacts/[contactId] PATCH). Replaces
 * `.update({ role }).eq('dealId', id).eq('contactId', contactId)`. Tri-state
 * role: a role value to set, null to clear. Returns the updated row, or null if
 * the pair doesn't exist.
 */
export const setRole = mutation({
  args: { dealId: v.string(), contactId: v.string(), role: v.union(roleValidator, v.null()) },
  handler: async (ctx, args) => {
    const dc = await ctx.db
      .query('DealContact')
      .withIndex('by_deal', (q) => q.eq('dealId', args.dealId))
      .collect();
    const row = dc.find((r) => r.contactId === args.contactId);
    if (!row) return null;
    await ctx.db.patch(row._id, { role: args.role ?? undefined });
    return toRow({ ...row, role: args.role ?? undefined });
  },
});

/**
 * Re-link a contact's deal memberships onto another contact, de-duplicated
 * (merge-persons). For every (dealId) the merged contact was on, ensure the kept
 * contact is linked, then drop all of the merged contact's links. Replaces the
 * route's read-dedupe-insert-then-delete sequence, now in one serializable
 * mutation. Returns the number of new links created for the kept contact.
 */
export const reassignContact = mutation({
  args: { fromContactId: v.string(), toContactId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const fromLinks = await ctx.db
      .query('DealContact')
      .withIndex('by_contact', (q) => q.eq('contactId', args.fromContactId))
      .collect();
    const toLinks = await ctx.db
      .query('DealContact')
      .withIndex('by_contact', (q) => q.eq('contactId', args.toContactId))
      .collect();
    const keptDeals = new Set(toLinks.map((l) => l.dealId));
    let created = 0;
    for (const l of fromLinks) {
      if (!keptDeals.has(l.dealId)) {
        await ctx.db.insert('DealContact', { dealId: l.dealId, contactId: args.toContactId });
        keptDeals.add(l.dealId);
        created++;
      }
      await ctx.db.delete(l._id);
    }
    return created;
  },
});

/**
 * Delete all of a contact's deal links (lead unassign/delete; the Contact ON
 * DELETE CASCADE hook). Replaces `.delete().eq('contactId', id)`. Returns the
 * dealIds that were unlinked so the caller can sweep now-orphaned deals
 * (unassign-lead deletes a deal that has no remaining contacts).
 */
export const deleteByContact = mutation({
  args: { contactId: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const rows = await ctx.db
      .query('DealContact')
      .withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
      .collect();
    const dealIds: string[] = [];
    for (const dc of rows) {
      dealIds.push(dc.dealId);
      await ctx.db.delete(dc._id);
    }
    return dealIds;
  },
});

/** Does a deal still have any contact links? (unassign-lead orphan sweep — delete
 *  the deal if not). Replaces `.eq('dealId', id).limit(1)` existence check. */
export const dealHasContacts = query({
  args: { dealId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query('DealContact')
      .withIndex('by_deal', (q) => q.eq('dealId', args.dealId))
      .first();
    return row !== null;
  },
});
