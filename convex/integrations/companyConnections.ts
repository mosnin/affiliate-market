import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * CompanyIntegrationConnection data access — the Convex replacement for the
 * Supabase reads/writes in lib/integrations/company-connections.ts. The
 * company-level analogue of ./connections.ts: Composio holds the OAuth tokens;
 * this table is the pointer + status + audit, scoped by (companyId, userId).
 *
 * Invariant carried from Postgres: at most one active row per
 * (companyId,userId,toolkit) (CompanyIntegrationConnection_active_unique). The
 * caller revokes the prior active row before inserting, so findActive uses
 * .first(). No secretCiphertext column here (no native integrations at the
 * company level). No trigger wiring at the company level.
 */

const statusValidator = v.union(
  v.literal('active'),
  v.literal('pending'),
  v.literal('expired'),
  v.literal('revoked'),
  v.literal('failed'),
);

/** Map a Convex doc to the legacy CompanyIntegrationConnectionRow shape (drop
 *  _id/_creationTime, surface `id`, coerce absent optionals back to SQL NULL). */
function toRow(doc: Doc<'CompanyIntegrationConnection'>) {
  return {
    id: doc.id,
    companyId: doc.companyId,
    userId: doc.userId,
    toolkit: doc.toolkit,
    composioConnectionId: doc.composioConnectionId,
    status: doc.status,
    label: doc.label ?? null,
    lastError: doc.lastError ?? null,
    lastUsedAt: doc.lastUsedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** All connections for a company, newest first. Mirrors listCompanyConnections(). */
export const listByCompany = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query('CompanyIntegrationConnection')
      .withIndex('by_company', (q) => q.eq('companyId', args.companyId))
      .collect();
    docs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return docs.map(toRow);
  },
});

/** Connections for a (company,user), newest first. Mirrors
 *  listCompanyConnectionsForUser(). */
export const listByCompanyUser = query({
  args: { companyId: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query('CompanyIntegrationConnection')
      .withIndex('by_company_user_toolkit', (q) =>
        q.eq('companyId', args.companyId).eq('userId', args.userId),
      )
      .collect();
    docs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return docs.map(toRow);
  },
});

/** Full row by Composio connection id, or null. Mirrors findCompanyByComposioId(). */
export const findByComposioId = query({
  args: { composioConnectionId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('CompanyIntegrationConnection')
      .withIndex('by_composio_id', (q) => q.eq('composioConnectionId', args.composioConnectionId))
      .first();
    return doc ? toRow(doc) : null;
  },
});

/** Full row by our own id, or null. Mirrors getCompanyConnectionById(). */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('CompanyIntegrationConnection')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return doc ? toRow(doc) : null;
  },
});

/** Any active row for a (company,user,toolkit), or null. Mirrors
 *  findActiveCompanyConnection(). At most one exists. */
export const findActive = query({
  args: { companyId: v.string(), userId: v.string(), toolkit: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('CompanyIntegrationConnection')
      .withIndex('by_company_user_toolkit', (q) =>
        q.eq('companyId', args.companyId).eq('userId', args.userId).eq('toolkit', args.toolkit),
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();
    return doc ? toRow(doc) : null;
  },
});

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Insert a company connection row. Caller revokes any prior active row first.
 *  Returns the persisted row. Mirrors insertCompanyConnection(). */
export const insert = mutation({
  args: {
    companyId: v.string(),
    userId: v.string(),
    toolkit: v.string(),
    composioConnectionId: v.string(),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      companyId: args.companyId,
      userId: args.userId,
      toolkit: args.toolkit,
      composioConnectionId: args.composioConnectionId,
      status: 'active' as const,
      label: args.label,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('CompanyIntegrationConnection', doc);
    return toRow(doc as Doc<'CompanyIntegrationConnection'>);
  },
});

/**
 * Upsert by composioConnectionId — patch label/status/lastError if present, else
 * insert. ONE serializable mutation. Mirrors upsertCompanyByComposioId(); the
 * status always lands 'active' (the company callback only confirms active).
 */
export const upsertByComposioId = mutation({
  args: {
    companyId: v.string(),
    userId: v.string(),
    toolkit: v.string(),
    composioConnectionId: v.string(),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('CompanyIntegrationConnection')
      .withIndex('by_composio_id', (q) => q.eq('composioConnectionId', args.composioConnectionId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        label: args.label ?? existing.label ?? undefined,
        status: 'active' as const,
        lastError: undefined, // clear it (was null)
        updatedAt: new Date().toISOString(),
      });
      const updated = await ctx.db.get(existing._id);
      return updated ? toRow(updated) : null;
    }

    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      companyId: args.companyId,
      userId: args.userId,
      toolkit: args.toolkit,
      composioConnectionId: args.composioConnectionId,
      status: 'active' as const,
      label: args.label,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('CompanyIntegrationConnection', doc);
    return toRow(doc as Doc<'CompanyIntegrationConnection'>);
  },
});

/** Flip a row's status (+ optional lastError), bump updatedAt. No-op if it
 *  vanished. Mirrors setCompanyConnectionStatus(). */
export const setStatus = mutation({
  args: { id: v.string(), status: statusValidator, lastError: v.optional(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query('CompanyIntegrationConnection')
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
