import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * IntegrationConnection data access — the Convex replacement for the Supabase
 * reads/writes in lib/integrations/connections.ts and the shared "find the
 * active connection for this space" reads scattered across lib/delivery.ts,
 * lib/communication/connect.ts, lib/calendar/mirror.ts, the briefing signal
 * sources, the admin trigger-backfill route, and the cola page banner count.
 *
 * Composio holds the OAuth tokens; this table is the pointer + status + audit.
 * secretCiphertext (native-integration credential) is ciphertext at rest — this
 * layer never touches the crypto; it stores/returns whatever string lib/crypto
 * hands it.
 *
 * Cross-domain orchestration (composio SDK calls, trigger registration) stays in
 * lib; only the DB hops move here.
 */

const statusValidator = v.union(
  v.literal('active'),
  v.literal('pending'),
  v.literal('expired'),
  v.literal('revoked'),
  v.literal('failed'),
);

/** Map a Convex doc to the legacy IntegrationConnectionRow shape: drop
 *  _id/_creationTime, surface `id`, coerce absent optionals back to the SQL
 *  NULLs the callers expect. */
function toRow(doc: Doc<'IntegrationConnection'>) {
  return {
    id: doc.id,
    spaceId: doc.spaceId,
    userId: doc.userId,
    toolkit: doc.toolkit,
    composioConnectionId: doc.composioConnectionId,
    status: doc.status,
    label: doc.label ?? null,
    lastError: doc.lastError ?? null,
    lastUsedAt: doc.lastUsedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    secretCiphertext: doc.secretCiphertext ?? null,
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** All connections for a space, newest first. Mirrors listConnections(). */
export const listBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query('IntegrationConnection')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    // createdAt DESC (matches `.order('createdAt', { ascending: false })`).
    docs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return docs.map(toRow);
  },
});

/** Active toolkit slugs for a (space,user). Mirrors activeToolkits(). Hot path
 *  (chat agent reads it every turn) — returns just the slugs. */
export const activeToolkits = query({
  args: { spaceId: v.string(), userId: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const docs = await ctx.db
      .query('IntegrationConnection')
      .withIndex('by_space_user_toolkit', (q) =>
        q.eq('spaceId', args.spaceId).eq('userId', args.userId),
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();
    return docs.map((d) => d.toolkit);
  },
});

/** Full row by Composio connection id, or null. Mirrors findByComposioId(). */
export const findByComposioId = query({
  args: { composioConnectionId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('IntegrationConnection')
      .withIndex('by_composio_id', (q) => q.eq('composioConnectionId', args.composioConnectionId))
      .first();
    return doc ? toRow(doc) : null;
  },
});

/** Full row by our own id, or null. Mirrors getById(). */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('IntegrationConnection')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return doc ? toRow(doc) : null;
  },
});

/** Any active row for a (space,user,toolkit), or null. Mirrors findActive().
 *  At most one exists (IntegrationConnection_active_unique). */
export const findActive = query({
  args: { spaceId: v.string(), userId: v.string(), toolkit: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('IntegrationConnection')
      .withIndex('by_space_user_toolkit', (q) =>
        q.eq('spaceId', args.spaceId).eq('userId', args.userId).eq('toolkit', args.toolkit),
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();
    return doc ? toRow(doc) : null;
  },
});

/** Pending rows for a (space,user,toolkit). Mirrors findPending() — the connect
 *  route sweeps these before a fresh OAuth flow. */
export const findPending = query({
  args: { spaceId: v.string(), userId: v.string(), toolkit: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query('IntegrationConnection')
      .withIndex('by_space_user_toolkit', (q) =>
        q.eq('spaceId', args.spaceId).eq('userId', args.userId).eq('toolkit', args.toolkit),
      )
      .filter((q) => q.eq(q.field('status'), 'pending'))
      .collect();
    return docs.map(toRow);
  },
});

/**
 * Active connections for a space, optionally narrowed to a toolkit set, ordered
 * by toolkit ascending. Backs the shared "find the active connection for this
 * space" reads in lib/delivery.ts, lib/communication/connect.ts,
 * lib/calendar/mirror.ts, and the briefing signal sources. Each caller takes the
 * first match (or filters the slim set) and maps only the columns it needs, so
 * one query serves the single-toolkit `.eq` and the multi-toolkit `.in` shapes.
 */
export const activeForSpace = query({
  args: {
    spaceId: v.string(),
    toolkits: v.optional(v.array(v.string())),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query('IntegrationConnection')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId).eq('status', 'active'))
      .collect();
    let filtered = docs;
    if (args.userId !== undefined) filtered = filtered.filter((d) => d.userId === args.userId);
    if (args.toolkits && args.toolkits.length > 0) {
      filtered = filtered.filter((d) => args.toolkits!.includes(d.toolkit));
    }
    // toolkit ASC (matches `.order('toolkit', { ascending: true })`).
    filtered.sort((a, b) => (a.toolkit < b.toolkit ? -1 : a.toolkit > b.toolkit ? 1 : 0));
    return filtered.map(toRow);
  },
});

/** Count of active connections for a space > 0. Mirrors the cola-page banner
 *  `select('id', { count:'exact', head:true }).eq(spaceId).eq(status,'active')`. */
export const hasActiveBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const doc = await ctx.db
      .query('IntegrationConnection')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId).eq('status', 'active'))
      .first();
    return doc !== null;
  },
});

/** Every active connection across all spaces. Backs the admin trigger-backfill
 *  route (`select('*').eq(status,'active')`). */
export const listAllActive = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query('IntegrationConnection')
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();
    return docs.map(toRow);
  },
});

// ─── Writes ──────────────────────────────────────────────────────────────────

/**
 * Insert a connection row. Caller revokes any prior active (space,user,toolkit)
 * row first (the unique-active invariant). Returns the persisted row. Mirrors
 * insertConnection(); `status` defaults to 'active', `label`/`secretCiphertext`
 * are optional.
 */
export const insert = mutation({
  args: {
    spaceId: v.string(),
    userId: v.string(),
    toolkit: v.string(),
    composioConnectionId: v.string(),
    label: v.optional(v.string()),
    status: v.optional(v.union(v.literal('active'), v.literal('pending'))),
    secretCiphertext: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      userId: args.userId,
      toolkit: args.toolkit,
      composioConnectionId: args.composioConnectionId,
      status: args.status ?? ('active' as const),
      label: args.label,
      ...(args.secretCiphertext ? { secretCiphertext: args.secretCiphertext } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('IntegrationConnection', doc);
    return toRow(doc as Doc<'IntegrationConnection'>);
  },
});

/**
 * Upsert by composioConnectionId. If a row with that Composio id exists, patch
 * its label/status/lastError; otherwise insert. ONE serializable mutation
 * (the old version did findByComposioId + update OR insert as separate hops).
 * Mirrors upsertByComposioId(); returns the resulting row.
 */
export const upsertByComposioId = mutation({
  args: {
    spaceId: v.string(),
    userId: v.string(),
    toolkit: v.string(),
    composioConnectionId: v.string(),
    label: v.optional(v.string()),
    status: v.optional(v.union(v.literal('active'), v.literal('pending'))),
  },
  handler: async (ctx, args) => {
    const targetStatus = args.status ?? ('active' as const);
    const existing = await ctx.db
      .query('IntegrationConnection')
      .withIndex('by_composio_id', (q) => q.eq('composioConnectionId', args.composioConnectionId))
      .first();

    if (existing) {
      const label = args.label ?? existing.label ?? undefined;
      await ctx.db.patch(existing._id, {
        // PG wrote `label ?? existing.label ?? null`; omit when absent so the
        // optional stays unset (toRow maps it back to null).
        label,
        status: targetStatus,
        lastError: undefined, // clear it (was set to null)
        updatedAt: new Date().toISOString(),
      });
      const updated = await ctx.db.get(existing._id);
      return updated ? toRow(updated) : null;
    }

    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      userId: args.userId,
      toolkit: args.toolkit,
      composioConnectionId: args.composioConnectionId,
      status: targetStatus,
      label: args.label,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('IntegrationConnection', doc);
    return toRow(doc as Doc<'IntegrationConnection'>);
  },
});

/** Flip a row's status (+ optional lastError), bump updatedAt. No-op if the row
 *  vanished. Mirrors setStatus(). */
export const setStatus = mutation({
  args: { id: v.string(), status: statusValidator, lastError: v.optional(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query('IntegrationConnection')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!existing) return;
    await ctx.db.patch(existing._id, {
      status: args.status,
      lastError: args.lastError, // absent -> cleared (was null)
      updatedAt: new Date().toISOString(),
    });
  },
});
