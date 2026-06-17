import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ClientUser data access — the Convex replacement for the `.from('ClientUser')`
 * ops in lib/client-auth.ts. This is the CLIENT-PORTAL identity store, fully
 * separate from seller Clerk auth.
 *
 * SECURITY: all password hashing / scrypt / timing-safe compare stays in
 * lib/client-auth.ts (pure node:crypto). This layer only stores and returns the
 * already-hashed passwordHash string and the user columns — it never hashes,
 * never compares, never issues sessions.
 *
 * ClientUser_emailLower_key UNIQUE(emailLower): exactly one account per
 * normalized email. `create` preserves it as a read-by-emailLower-then-insert
 * inside one serializable mutation (the old code leaned on the unique index +
 * an error return; here the read makes it race-safe and explicit).
 */

/** The public ClientUserRow shape (lib USER_COLS): id, email, emailLower, name,
 *  phone, emailVerifiedAt. Absent optionals -> SQL NULL. */
function toUserRow(u: {
  id: string;
  email: string;
  emailLower: string;
  name?: string;
  phone?: string;
  emailVerifiedAt?: string;
}) {
  return {
    id: u.id,
    email: u.email,
    emailLower: u.emailLower,
    name: u.name ?? null,
    phone: u.phone ?? null,
    emailVerifiedAt: u.emailVerifiedAt ?? null,
  };
}

/**
 * findClientByEmail: the user (INCLUDING passwordHash) by emailLower, or null.
 * Mirrors `.select(USER_COLS, passwordHash).eq('emailLower').maybeSingle()`. The
 * lib lowercases before calling. Returns passwordHash so the lib can verify it.
 */
export const findByEmail = query({
  args: { emailLower: v.string() },
  handler: async (ctx, args) => {
    const u = await ctx.db
      .query('ClientUser')
      .withIndex('by_email_lower', (q) => q.eq('emailLower', args.emailLower))
      .unique();
    if (!u) return null;
    return { ...toUserRow(u), passwordHash: u.passwordHash };
  },
});

/** findClientById: the public user row (NO passwordHash) by id, or null — the
 *  session resolver. Mirrors `.select(USER_COLS).eq('id').maybeSingle()`. */
export const findById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const u = await ctx.db
      .query('ClientUser')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return u ? toUserRow(u) : null;
  },
});

/**
 * createClientUser. Replaces the INSERT. The lib computes emailLower and the
 * passwordHash and passes them in. UNIQUE(emailLower) is preserved by reading
 * first: an existing account returns null (the old insert returned null on the
 * unique-violation error), so the caller treats it as "already exists". name/
 * phone null = unset. Returns the public row (no passwordHash).
 */
export const create = mutation({
  args: {
    email: v.string(),
    emailLower: v.string(),
    passwordHash: v.string(),
    name: v.union(v.string(), v.null()),
    phone: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('ClientUser')
      .withIndex('by_email_lower', (q) => q.eq('emailLower', args.emailLower))
      .unique();
    if (existing) return null; // UNIQUE(emailLower) violation -> null, as the old code did

    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomUUID(),
      email: args.email,
      emailLower: args.emailLower,
      passwordHash: args.passwordHash,
      ...(args.name !== null ? { name: args.name } : {}),
      ...(args.phone !== null ? { phone: args.phone } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('ClientUser', doc);
    return toUserRow(doc);
  },
});

/**
 * markEmailVerified: stamp emailVerifiedAt + updatedAt for the account with this
 * emailLower. Mirrors `.update({ emailVerifiedAt, updatedAt }).eq('emailLower')`.
 * No-op if no such account.
 */
export const markEmailVerified = mutation({
  args: { emailLower: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const u = await ctx.db
      .query('ClientUser')
      .withIndex('by_email_lower', (q) => q.eq('emailLower', args.emailLower))
      .unique();
    if (!u) return;
    const now = new Date().toISOString();
    await ctx.db.patch(u._id, { emailVerifiedAt: now, updatedAt: now });
  },
});

/**
 * setClientPassword: replace passwordHash (already hashed in lib) + bump
 * updatedAt for the account with this emailLower. Mirrors
 * `.update({ passwordHash, updatedAt }).eq('emailLower')`. No-op if absent.
 */
export const setPassword = mutation({
  args: { emailLower: v.string(), passwordHash: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const u = await ctx.db
      .query('ClientUser')
      .withIndex('by_email_lower', (q) => q.eq('emailLower', args.emailLower))
      .unique();
    if (!u) return;
    await ctx.db.patch(u._id, {
      passwordHash: args.passwordHash,
      updatedAt: new Date().toISOString(),
    });
  },
});
