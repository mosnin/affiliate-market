import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * McpAuthCode data access — the Convex replacement for `.from('McpAuthCode')` in
 * the OAuth authorize + token routes.
 *
 * SECURITY (preserve EXACTLY): an authorization code is short-lived (5 min) and
 * single-use. The token route fetches the FULL row by `code`, then validates
 * expiry, PKCE (sha256 of code_verifier vs stored codeChallenge), redirect_uri,
 * and the state nonce — ALL in the route (pure crypto). It deletes the code by
 * `code` at every failed gate AND on success, so a code can never be replayed.
 * These functions only do the by-code fetch + by-code delete; the crypto stays
 * put. UNIQUE(code) is preserved by the by_code index + `.unique()` lookups.
 */

type AuthCodeFields = {
  id: string;
  code: string;
  clientId: string;
  spaceId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  expiresAt: string;
  createdAt: string;
  stateNonce?: string;
  stateHash?: string;
};

/** The full row the token route reads (it `.select('*')`). Optionals -> null. */
function toAuthCodeRow(c: AuthCodeFields) {
  return {
    id: c.id,
    code: c.code,
    clientId: c.clientId,
    spaceId: c.spaceId,
    codeChallenge: c.codeChallenge,
    codeChallengeMethod: c.codeChallengeMethod,
    redirectUri: c.redirectUri,
    expiresAt: c.expiresAt,
    createdAt: c.createdAt,
    stateNonce: c.stateNonce ?? null,
    stateHash: c.stateHash ?? null,
  };
}

/** Token exchange: fetch the full auth-code row by code, or null. Mirrors
 *  `.from('McpAuthCode').select('*').eq('code', code).maybeSingle()`. All
 *  validation runs on the returned fields in the route. */
export const getByCode = query({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db
      .query('McpAuthCode')
      .withIndex('by_code', (q) => q.eq('code', args.code))
      .unique();
    return c ? toAuthCodeRow(c) : null;
  },
});

/** Single-use delete by code. Mirrors `.from('McpAuthCode').delete().eq('code',
 *  code)` — fired by the token route at each failed validation gate and on
 *  successful redemption. Idempotent (no-op if already gone). */
export const deleteByCode = mutation({
  args: { code: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const c = await ctx.db
      .query('McpAuthCode')
      .withIndex('by_code', (q) => q.eq('code', args.code))
      .unique();
    if (c) await ctx.db.delete(c._id);
  },
});

/** Create an authorization code. POST /api/mcp/oauth/authorize generated the
 *  random `code`, the 5-minute expiresAt, the stateNonce and the (optional)
 *  stateHash, and validated the redirect_uri; this persists the row.
 *  codeChallengeMethod defaults to 'S256'. UNIQUE(code) preserved via a
 *  read-then-insert (the random 32-byte code never collides in practice). */
export const create = mutation({
  args: {
    code: v.string(),
    clientId: v.string(),
    spaceId: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.optional(v.string()),
    redirectUri: v.string(),
    expiresAt: v.string(),
    stateNonce: v.union(v.string(), v.null()),
    stateHash: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<void> => {
    const clash = await ctx.db
      .query('McpAuthCode')
      .withIndex('by_code', (q) => q.eq('code', args.code))
      .unique();
    if (clash) throw new Error('McpAuthCode.code already exists');
    await ctx.db.insert('McpAuthCode', {
      id: crypto.randomUUID(),
      code: args.code,
      clientId: args.clientId,
      spaceId: args.spaceId,
      codeChallenge: args.codeChallenge,
      codeChallengeMethod: args.codeChallengeMethod || 'S256',
      redirectUri: args.redirectUri,
      expiresAt: args.expiresAt,
      ...(args.stateNonce !== null ? { stateNonce: args.stateNonce } : {}),
      ...(args.stateHash !== null ? { stateHash: args.stateHash } : {}),
      createdAt: new Date().toISOString(),
    });
  },
});
