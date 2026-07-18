import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ClientAuthCode data access — the Convex replacement for the `.from('ClientAuthCode')`
 * ops in lib/client-auth.ts (issueCode / consumeCode). One-time, attempt-limited
 * 6-digit codes, HASHED at rest, for the client portal's email verification +
 * passwordless login + password reset.
 *
 * SECURITY — what stays in lib (pure node:crypto), untouched:
 *   - generateCode() (the 6 random digits) and hashCode() (sha256).
 *   - The timing-safe codeHash comparison in consumeCode.
 *   - The MAX_CODE_ATTEMPTS / CODE_TTL_MINUTES policy values.
 * This layer only stores hashes and surfaces the candidate row's {id, codeHash,
 * attempts} so the lib can do the compare, then patches attempts/consumedAt by
 * id. It NEVER sees a plaintext code.
 *
 * One-time-use invariants preserved:
 *   - issueCode FIRST invalidates every prior unconsumed code for (emailLower,
 *     purpose) so only the newest is ever live — `invalidatePrior` does that
 *     bulk consume inside one serializable mutation (read-then-patch all).
 *   - consumeCode reads the single newest unconsumed, unexpired candidate
 *     (ClientAuthCode_lookup_idx predicate), and on success consumes THAT row by
 *     id — `consume` patches consumedAt only if still unconsumed (idempotent /
 *     race-safe), so a code is spent exactly once.
 */

const purposeValidator = v.union(v.literal('verify'), v.literal('login'), v.literal('reset'));

/**
 * Invalidate (consume) every still-live code for (emailLower, purpose) — the
 * pre-insert step of issueCode (`.update({consumedAt}).eq('emailLower').
 * eq('purpose').is('consumedAt',null)`). Read-then-patch-all in one mutation so
 * a concurrent resend can't leave two live codes.
 */
export const invalidatePrior = mutation({
  args: { emailLower: v.string(), purpose: purposeValidator },
  handler: async (ctx, args): Promise<void> => {
    const now = new Date().toISOString();
    const live = await ctx.db
      .query('ClientAuthCode')
      .withIndex('by_email_purpose', (q) =>
        q.eq('emailLower', args.emailLower).eq('purpose', args.purpose),
      )
      .collect();
    for (const c of live) {
      if (c.consumedAt == null) await ctx.db.patch(c._id, { consumedAt: now });
    }
  },
});

/**
 * Insert a new code (issueCode). The lib computes codeHash (sha256 of the
 * plaintext) and expiresAt and passes them in. attempts defaults to 0,
 * createdAt to now (PG defaults). Mirrors the `.insert({ emailLower, codeHash,
 * purpose, expiresAt })`.
 */
export const issue = mutation({
  args: {
    emailLower: v.string(),
    codeHash: v.string(),
    purpose: purposeValidator,
    expiresAt: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('ClientAuthCode', {
      id: crypto.randomUUID(),
      emailLower: args.emailLower,
      codeHash: args.codeHash,
      purpose: args.purpose,
      expiresAt: args.expiresAt,
      attempts: 0,
      createdAt: new Date().toISOString(),
    });
  },
});

/**
 * The single newest UNCONSUMED, UNEXPIRED candidate for (emailLower, purpose) —
 * {id, codeHash, attempts} or null. Mirrors consumeCode's
 * `.select('id, codeHash, attempts').eq('emailLower').eq('purpose').
 * is('consumedAt',null).gt('expiresAt', now).order('createdAt', desc).limit(1).maybeSingle()`.
 * The lib then checks attempts < MAX and timing-safe-compares codeHash itself.
 * `now` is passed in so the expiry boundary matches the caller's clock.
 */
export const findCandidate = query({
  args: { emailLower: v.string(), purpose: purposeValidator, now: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('ClientAuthCode')
      .withIndex('by_email_purpose', (q) =>
        q.eq('emailLower', args.emailLower).eq('purpose', args.purpose),
      )
      .collect();
    const live = rows.filter((c) => c.consumedAt == null && c.expiresAt > args.now);
    if (live.length === 0) return null;
    live.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const top = live[0];
    return { id: top.id, codeHash: top.codeHash, attempts: top.attempts };
  },
});

/**
 * Increment a candidate's failed-attempt counter by id (consumeCode's bad-code
 * branch: `.update({ attempts: attempts+1 }).eq('id')`). Reads the row and
 * increments from the stored value (race-safe vs. the lib passing a stale count).
 * No-op if the row vanished.
 */
export const incrementAttempts = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const c = await ctx.db
      .query('ClientAuthCode')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c) return;
    await ctx.db.patch(c._id, { attempts: c.attempts + 1 });
  },
});

/**
 * Consume a candidate by id on a successful match (consumeCode's success
 * branch: `.update({ consumedAt }).eq('id')`). Only stamps if still unconsumed,
 * so the code is spent exactly once even under a race. No-op if absent.
 */
export const consume = mutation({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const c = await ctx.db
      .query('ClientAuthCode')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!c || c.consumedAt != null) return;
    await ctx.db.patch(c._id, { consumedAt: new Date().toISOString() });
  },
});
