import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * McpApiKey data access — the Convex replacement for `.from('McpApiKey')` in the
 * MCP auth + key-management routes.
 *
 * SECURITY (preserve EXACTLY): authentication looks a key up by its sha256
 * `keyHash` (raw Bearer key) or by `clientId` (OAuth client_credentials). The
 * hashing, constant-time secret comparison, expiry decision (NULL expiresAt =
 * legacy, never expires) and JWT signing all stay in the route — these queries
 * only fetch the stored row by the same key the route hashes with. The returned
 * shapes match the exact `.select(...)` column lists so the route's checks are
 * byte-for-byte unchanged.
 *
 * UNIQUE(clientId) is preserved by indexing clientId and using `.unique()`
 * lookups; the create path mints a fresh random clientId (collision-free in
 * practice, as before).
 */

type KeyDoc = {
  id: string;
  spaceId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  lastUsedAt?: string;
  createdAt: string;
  clientId?: string;
  clientSecretHash?: string;
  expiresAt?: string;
};

// ── Auth reads (security-critical — exact lookup keys + column projections) ───

/** Bearer-key auth: by keyHash, return (spaceId, expiresAt). Mirrors
 *  `.select('spaceId, expiresAt').eq('keyHash', keyHash).maybeSingle()` in
 *  app/api/mcp/route.ts. Expiry is checked by the caller. */
export const authByKeyHash = query({
  args: { keyHash: v.string() },
  handler: async (ctx, args): Promise<{ spaceId: string; expiresAt: string | null } | null> => {
    const k = await ctx.db
      .query('McpApiKey')
      .withIndex('by_key_hash', (q) => q.eq('keyHash', args.keyHash))
      .unique();
    if (!k) return null;
    return { spaceId: k.spaceId, expiresAt: k.expiresAt ?? null };
  },
});

/** client_credentials auth: by clientId, return (spaceId, clientSecretHash,
 *  expiresAt). Mirrors `.select('spaceId, clientSecretHash, expiresAt')
 *  .eq('clientId', client_id).maybeSingle()` in the token route. The route does
 *  the constant-time hash compare + expiry check. */
export const authByClientId = query({
  args: { clientId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ spaceId: string; clientSecretHash: string | null; expiresAt: string | null } | null> => {
    const k = await ctx.db
      .query('McpApiKey')
      .withIndex('by_client_id', (q) => q.eq('clientId', args.clientId))
      .unique();
    if (!k) return null;
    return {
      spaceId: k.spaceId,
      clientSecretHash: k.clientSecretHash ?? null,
      expiresAt: k.expiresAt ?? null,
    };
  },
});

/** OAuth authorize endpoint: by clientId, return (spaceId, expiresAt). Mirrors
 *  `.select('spaceId, expiresAt').eq('clientId', client_id).maybeSingle()` in
 *  app/api/mcp/oauth/authorize/route.ts. */
export const spaceAndExpiryByClientId = query({
  args: { clientId: v.string() },
  handler: async (ctx, args): Promise<{ spaceId: string; expiresAt: string | null } | null> => {
    const k = await ctx.db
      .query('McpApiKey')
      .withIndex('by_client_id', (q) => q.eq('clientId', args.clientId))
      .unique();
    if (!k) return null;
    return { spaceId: k.spaceId, expiresAt: k.expiresAt ?? null };
  },
});

/** Consent page: by clientId, return (id, name, spaceId). Mirrors
 *  `.select('id, name, spaceId').eq('clientId', params.client_id)
 *  .maybeSingle()` in app/authorize/page.tsx. */
export const summaryByClientId = query({
  args: { clientId: v.string() },
  handler: async (ctx, args): Promise<{ id: string; name: string; spaceId: string } | null> => {
    const k = await ctx.db
      .query('McpApiKey')
      .withIndex('by_client_id', (q) => q.eq('clientId', args.clientId))
      .unique();
    if (!k) return null;
    return { id: k.id, name: k.name, spaceId: k.spaceId };
  },
});

// ── Key-management reads ──────────────────────────────────────────────────────

/** List a space's keys newest-first (NO secret material). Mirrors GET
 *  /api/mcp-keys: `.select('id, name, keyPrefix, lastUsedAt, createdAt,
 *  expiresAt').eq('spaceId').order(createdAt desc)`. */
export const listForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('McpApiKey')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      lastUsedAt: k.lastUsedAt ?? null,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt ?? null,
    }));
  },
});

/** Count a space's keys (the 20-key cap pre-check). Mirrors
 *  `.select('*', { count: 'exact', head: true }).eq('spaceId')`. */
export const countForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('McpApiKey')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.length;
  },
});

/** Ownership pre-check before delete: does (id, spaceId) exist? Mirrors
 *  `.select('id').eq('id', id).eq('spaceId', space.id).maybeSingle()`. */
export const existsForSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const k = await ctx.db
      .query('McpApiKey')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return !!k && k.spaceId === args.spaceId;
  },
});

/** GDPR export: all of a space's key rows (full columns, incl. hashes). Mirrors
 *  `.from('McpApiKey').select('*').eq('spaceId', space.id)`. */
export const allForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('McpApiKey')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    return rows.map((k: KeyDoc) => ({
      id: k.id,
      spaceId: k.spaceId,
      name: k.name,
      keyHash: k.keyHash,
      keyPrefix: k.keyPrefix,
      lastUsedAt: k.lastUsedAt ?? null,
      createdAt: k.createdAt,
      clientId: k.clientId ?? null,
      clientSecretHash: k.clientSecretHash ?? null,
      expiresAt: k.expiresAt ?? null,
    }));
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/** Create a key. POST /api/mcp-keys generated all the secret material (raw key
 *  hash, prefix, clientId, clientSecretHash) and a 365-day expiresAt; this
 *  persists them. name defaults to 'Default'. Returns the non-secret subset the
 *  route echoes (id, name, keyPrefix, createdAt, clientId, expiresAt). */
export const create = mutation({
  args: {
    spaceId: v.string(),
    name: v.optional(v.string()),
    keyHash: v.string(),
    keyPrefix: v.string(),
    clientId: v.string(),
    clientSecretHash: v.string(),
    expiresAt: v.string(),
  },
  handler: async (ctx, args) => {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await ctx.db.insert('McpApiKey', {
      id,
      spaceId: args.spaceId,
      name: args.name && args.name.length > 0 ? args.name : 'Default',
      keyHash: args.keyHash,
      keyPrefix: args.keyPrefix,
      clientId: args.clientId,
      clientSecretHash: args.clientSecretHash,
      expiresAt: args.expiresAt,
      createdAt,
    });
    return {
      id,
      name: args.name && args.name.length > 0 ? args.name : 'Default',
      keyPrefix: args.keyPrefix,
      createdAt,
      clientId: args.clientId,
      expiresAt: args.expiresAt,
    };
  },
});

/** Bump lastUsedAt for the key with this keyHash (fire-and-forget in the route).
 *  Mirrors `.update({ lastUsedAt }).eq('keyHash', keyHash)`. */
export const touchByKeyHash = mutation({
  args: { keyHash: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const k = await ctx.db
      .query('McpApiKey')
      .withIndex('by_key_hash', (q) => q.eq('keyHash', args.keyHash))
      .unique();
    if (k) await ctx.db.patch(k._id, { lastUsedAt: new Date().toISOString() });
  },
});

/** Bump lastUsedAt for the key with this clientId (token-route success paths).
 *  Mirrors `.update({ lastUsedAt }).eq('clientId', clientId)`. */
export const touchByClientId = mutation({
  args: { clientId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const k = await ctx.db
      .query('McpApiKey')
      .withIndex('by_client_id', (q) => q.eq('clientId', args.clientId))
      .unique();
    if (k) await ctx.db.patch(k._id, { lastUsedAt: new Date().toISOString() });
  },
});

/** Revoke (delete) a key by id. Mirrors `.from('McpApiKey').delete().eq('id',
 *  id)` (both DELETE routes; ownership was verified by existsForSpace first).
 *  No space scope in the delete itself, matching the old code. */
export const deleteById = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const k = await ctx.db
      .query('McpApiKey')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (k) await ctx.db.delete(k._id);
  },
});
