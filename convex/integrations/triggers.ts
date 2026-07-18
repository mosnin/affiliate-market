import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * IntegrationTrigger data access — the Convex replacement for the eight Supabase
 * DB hops in lib/integrations/triggers.ts and the attendee-fired read in
 * lib/briefing/signal-sources/calendar-google.ts. All the curation / dispatch /
 * templating logic stays pure in lib; only the DB hops move here.
 *
 * Invariant carried from Postgres: unique (connectionId, triggerSlug)
 * (IntegrationTrigger_connection_slug_unique). The old upsert used onConflict on
 * that pair; `upsertRow` re-implements it as read-by-(connectionId,triggerSlug)-
 * then-patch-or-insert inside one serializable mutation.
 */

const triggerStatusValidator = v.union(
  v.literal('active'),
  v.literal('paused'),
  v.literal('failed'),
);

/** Map a Convex doc to the legacy IntegrationTriggerRow shape (drop _id/
 *  _creationTime, surface `id`, coerce absent optionals back to SQL NULL). */
function toRow(doc: Doc<'IntegrationTrigger'>) {
  return {
    id: doc.id,
    connectionId: doc.connectionId,
    composioTriggerId: doc.composioTriggerId ?? null,
    triggerSlug: doc.triggerSlug,
    status: doc.status,
    lastFiredAt: doc.lastFiredAt ?? null,
    lastError: doc.lastError ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** All trigger rows for a connection. Mirrors listTriggersForConnection(). */
export const listForConnection = query({
  args: { connectionId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query('IntegrationTrigger')
      .withIndex('by_connection', (q) => q.eq('connectionId', args.connectionId))
      .collect();
    return docs.map(toRow);
  },
});

/** Full row by Composio's trigger id, or null. Mirrors findByComposioTriggerId()
 *  — the webhook receiver's join key. */
export const findByComposioTriggerId = query({
  args: { composioTriggerId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('IntegrationTrigger')
      .withIndex('by_composio_trigger_id', (q) => q.eq('composioTriggerId', args.composioTriggerId))
      .first();
    return doc ? toRow(doc) : null;
  },
});

/** True if the connection has at least one active trigger. Mirrors
 *  hasActiveTriggers() (the `count head:true` read). */
export const hasActive = query({
  args: { connectionId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const doc = await ctx.db
      .query('IntegrationTrigger')
      .withIndex('by_connection', (q) => q.eq('connectionId', args.connectionId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();
    return doc !== null;
  },
});

/**
 * (connectionId, status) pairs for a set of connections. Backs
 * summariesForConnections() — the lib computes the per-connection summary
 * (off/active/paused/failed precedence). Convex has no `.in()`, so we gather per
 * connection off the by_connection index and concat.
 */
export const statusesForConnections = query({
  args: { connectionIds: v.array(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ connectionId: string; status: 'active' | 'paused' | 'failed' }>> => {
    const out: Array<{ connectionId: string; status: 'active' | 'paused' | 'failed' }> = [];
    for (const connectionId of args.connectionIds) {
      const docs = await ctx.db
        .query('IntegrationTrigger')
        .withIndex('by_connection', (q) => q.eq('connectionId', connectionId))
        .collect();
      for (const d of docs) out.push({ connectionId: d.connectionId, status: d.status });
    }
    return out;
  },
});

/**
 * The most-recent lastFiredAt for an active trigger on a connection matching a
 * slug, or null. Backs lib/briefing/signal-sources/calendar-google.ts's
 * attendeeTriggerFiredRecently (`select('lastFiredAt').eq(connectionId)
 * .eq(triggerSlug).eq(status,'active').maybeSingle`).
 */
export const lastFiredForSlug = query({
  args: { connectionId: v.string(), triggerSlug: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const doc = await ctx.db
      .query('IntegrationTrigger')
      .withIndex('by_connection', (q) => q.eq('connectionId', args.connectionId))
      .filter((q) =>
        q.and(
          q.eq(q.field('triggerSlug'), args.triggerSlug),
          q.eq(q.field('status'), 'active'),
        ),
      )
      .first();
    return doc?.lastFiredAt ?? null;
  },
});

// ─── Writes ──────────────────────────────────────────────────────────────────

/**
 * Upsert a trigger row keyed on (connectionId, triggerSlug). Preserves the old
 * onConflict('connectionId,triggerSlug') upsert as read-then-patch/insert in one
 * serializable mutation. Returns true (the old helper returned ok:boolean; a
 * thrown DB error surfaces as a rejected mutation, which the lib catch treats as
 * false). Mirrors upsertTriggerRow().
 */
export const upsertRow = mutation({
  args: {
    connectionId: v.string(),
    triggerSlug: v.string(),
    composioTriggerId: v.union(v.string(), v.null()),
    status: triggerStatusValidator,
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const now = new Date().toISOString();
    const existing = await ctx.db
      .query('IntegrationTrigger')
      .withIndex('by_connection', (q) => q.eq('connectionId', args.connectionId))
      .filter((q) => q.eq(q.field('triggerSlug'), args.triggerSlug))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        composioTriggerId: args.composioTriggerId ?? undefined,
        status: args.status,
        lastError: args.lastError, // absent -> cleared (was null)
        updatedAt: now,
      });
      return true;
    }

    await ctx.db.insert('IntegrationTrigger', {
      id: crypto.randomUUID(),
      connectionId: args.connectionId,
      ...(args.composioTriggerId !== null ? { composioTriggerId: args.composioTriggerId } : {}),
      triggerSlug: args.triggerSlug,
      status: args.status,
      ...(args.lastError !== undefined ? { lastError: args.lastError } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return true;
  },
});

/** Delete every trigger row for a connection. Mirrors the DB-side delete in
 *  deleteForConnection() (the Composio-side delete stays in lib). */
export const deleteForConnection = mutation({
  args: { connectionId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const docs = await ctx.db
      .query('IntegrationTrigger')
      .withIndex('by_connection', (q) => q.eq('connectionId', args.connectionId))
      .collect();
    for (const d of docs) await ctx.db.delete(d._id);
  },
});

/**
 * Flip every row for a connection from the opposite status to the target status
 * (active<->paused), bump updatedAt. Returns how many rows changed. 'failed' rows
 * are left alone (only rows currently at `oppositeStatus` move). Mirrors
 * setPausedForConnection().
 */
export const setPausedForConnection = mutation({
  args: { connectionId: v.string(), paused: v.boolean() },
  handler: async (ctx, args): Promise<{ updated: number }> => {
    const targetStatus: 'active' | 'paused' = args.paused ? 'paused' : 'active';
    const oppositeStatus: 'active' | 'paused' = args.paused ? 'active' : 'paused';
    const now = new Date().toISOString();
    const docs = await ctx.db
      .query('IntegrationTrigger')
      .withIndex('by_connection', (q) => q.eq('connectionId', args.connectionId))
      .filter((q) => q.eq(q.field('status'), oppositeStatus))
      .collect();
    for (const d of docs) {
      await ctx.db.patch(d._id, { status: targetStatus, updatedAt: now });
    }
    return { updated: docs.length };
  },
});

/** Stamp lastFiredAt (+ updatedAt) on a trigger row by id. No-op if it vanished.
 *  Mirrors stampFired(). */
export const stampFired = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query('IntegrationTrigger')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!existing) return;
    const now = new Date().toISOString();
    await ctx.db.patch(existing._id, { lastFiredAt: now, updatedAt: now });
  },
});
