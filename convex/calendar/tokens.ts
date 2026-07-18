import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * GoogleCalendarToken data access — Convex replacement for the Supabase reads/
 * writes in lib/gcal-helpers.ts, app/api/demos/gcal/route.ts, and
 * app/api/demos/available/route.ts.
 *
 * Invariant carried from Postgres: ONE token row per space (the old upsert was
 * keyed on spaceId). Convex has no unique constraint, so `upsert` re-implements
 * it as read-by-space-then-patch-or-insert inside one serializable mutation.
 *
 * Token columns are ciphertext at rest; this layer never touches the crypto —
 * it stores and returns whatever string the app layer (lib/crypto) hands it.
 */

/** Full token row in the legacy shape (drop _id/_creationTime, surface `id`).
 *  All token columns are NOT NULL in PG, so no optional coercion is needed. */
function toRow(doc: {
  id: string;
  spaceId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  calendarId: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: doc.id,
    spaceId: doc.spaceId,
    accessToken: doc.accessToken,
    refreshToken: doc.refreshToken,
    expiresAt: doc.expiresAt,
    calendarId: doc.calendarId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * The full token row for a space, or null. Replaces the `.select('*')` /
 * `.select('accessToken, refreshToken, expiresAt, calendarId')` maybeSingle
 * reads (refresh dance, freeBusy, sync_demo, deleteGoogleEvent).
 */
export const getBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('GoogleCalendarToken')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    return doc ? toRow(doc) : null;
  },
});

/**
 * Connection-status read: just id/calendarId/createdAt, or null. Replaces the
 * `.select('id, calendarId, createdAt')` read in the gcal GET handler.
 */
export const getStatusBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query('GoogleCalendarToken')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    if (!doc) return null;
    return { id: doc.id, calendarId: doc.calendarId, createdAt: doc.createdAt };
  },
});

/**
 * Upsert the token for a space (OAuth code exchange). One row per space.
 *
 * `refreshToken` is optional because Google omits it on re-authorization when
 * one already exists — in that case we keep the stored refresh token (the old
 * upsert achieved this by omitting the column from the update payload). On a
 * fresh connect there is no existing row, so a refreshToken MUST be supplied.
 */
export const upsert = mutation({
  args: {
    spaceId: v.string(),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresAt: v.string(),
    calendarId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const now = new Date().toISOString();
    const existing = await ctx.db
      .query('GoogleCalendarToken')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();

    if (existing) {
      const patch: {
        accessToken: string;
        expiresAt: string;
        updatedAt: string;
        refreshToken?: string;
        calendarId?: string;
      } = {
        accessToken: args.accessToken,
        expiresAt: args.expiresAt,
        updatedAt: now,
      };
      // Only overwrite refreshToken when Google actually returned a new one.
      if (args.refreshToken !== undefined) patch.refreshToken = args.refreshToken;
      if (args.calendarId !== undefined) patch.calendarId = args.calendarId;
      await ctx.db.patch(existing._id, patch);
      return;
    }

    await ctx.db.insert('GoogleCalendarToken', {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      accessToken: args.accessToken,
      // First connect always carries a refresh token; fall back to '' only if a
      // caller somehow omits it (the OAuth flow rejects that case upstream).
      refreshToken: args.refreshToken ?? '',
      expiresAt: args.expiresAt,
      calendarId: args.calendarId ?? 'primary',
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Update the cached access token after a refresh (accessToken + expiresAt +
 * updatedAt). Replaces the three identical `.update({...}).eq('spaceId', ...)`
 * writes in the refresh paths. No-op if the row vanished mid-refresh.
 */
export const updateTokens = mutation({
  args: {
    spaceId: v.string(),
    accessToken: v.string(),
    expiresAt: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query('GoogleCalendarToken')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    if (!existing) return;
    await ctx.db.patch(existing._id, {
      accessToken: args.accessToken,
      expiresAt: args.expiresAt,
      updatedAt: new Date().toISOString(),
    });
  },
});

/** Disconnect: delete the space's token row. Replaces `.delete().eq('spaceId')`. */
export const deleteBySpace = mutation({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query('GoogleCalendarToken')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
