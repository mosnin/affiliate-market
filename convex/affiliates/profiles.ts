import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * CreatorProfile data access — the Convex replacement for the
 * `.from('CreatorProfile')` reads & writes in lib/affiliates/creators.ts.
 *
 * Pure logic stays in lib: channel validation (CREATOR_CHANNELS), field clamping
 * (bio 600, niche 120, audienceSize 0..1e9, channels<=8, websiteUrl 2048),
 * channel/audience formatting. The "joined this seller?" annotation joins
 * AffiliatePartner in lib (partners is its own Convex module).
 *
 * Invariant preserved: CreatorProfile_emailLower_key UNIQUE(emailLower) — one
 * profile per creator. upsert reads by_email_lower then inserts-or-patches the
 * single row, race-free in one mutation (replaces the PG upsert onConflict).
 */

type ProfileFields = {
  id: string;
  emailLower: string;
  name: string;
  clerkUserId?: string;
  bio?: string;
  niche?: string;
  audienceSize: number;
  channels: string[];
  websiteUrl?: string;
  avatarUrl?: string;
  listed: boolean;
  createdAt: string;
  updatedAt: string;
};

/** CreatorProfileRow shape (lib/affiliates/creators.ts#CreatorProfileRow).
 *  Surface `id`, coerce absent optionals -> null, channels always an array. */
function toProfileRow(p: ProfileFields) {
  return {
    id: p.id,
    emailLower: p.emailLower,
    name: p.name,
    clerkUserId: p.clerkUserId ?? null,
    bio: p.bio ?? null,
    niche: p.niche ?? null,
    audienceSize: p.audienceSize ?? 0,
    channels: Array.isArray(p.channels) ? p.channels : [],
    websiteUrl: p.websiteUrl ?? null,
    avatarUrl: p.avatarUrl ?? null,
    listed: Boolean(p.listed),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** One profile by emailLower, or null. Mirrors getCreatorProfileByEmail (the lib
 *  lowercases first). by_email_lower (UNIQUE). */
export const getByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('CreatorProfile')
      .withIndex('by_email_lower', (q) => q.eq('emailLower', args.email.trim().toLowerCase()))
      .unique();
    return p ? toProfileRow(p) : null;
  },
});

/**
 * Create-or-update a creator profile keyed by emailLower (upsertCreatorProfile).
 * The lib validated/clamped every field and passes only the columns it set
 * (undefined = leave unchanged on update; on insert, PG defaults apply:
 * audienceSize 0, channels [], listed false). emailLower + name + updatedAt are
 * always written. Read-then-insert-or-patch preserves the UNIQUE(emailLower)
 * invariant. Returns the row.
 *
 * Each optional arg is a union with null:
 *   - absent (undefined)  → field not provided, leave as-is on update.
 *   - null                → explicit clear (PG stored NULL).
 *   - value               → set it.
 */
export const upsert = mutation({
  args: {
    email: v.string(),
    name: v.string(),
    clerkUserId: v.optional(v.union(v.string(), v.null())),
    bio: v.optional(v.union(v.string(), v.null())),
    niche: v.optional(v.union(v.string(), v.null())),
    audienceSize: v.optional(v.number()),
    channels: v.optional(v.array(v.string())),
    websiteUrl: v.optional(v.union(v.string(), v.null())),
    listed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const emailLower = args.email.trim().toLowerCase();
    const name = args.name.trim();
    const now = new Date().toISOString();

    const existing = await ctx.db
      .query('CreatorProfile')
      .withIndex('by_email_lower', (q) => q.eq('emailLower', emailLower))
      .unique();

    // Build the set of column writes from the provided args. null -> absent
    // (SQL NULL) for nullable text columns; values set; undefined skipped.
    const writes: Record<string, unknown> = { name, updatedAt: now };
    if (args.clerkUserId !== undefined)
      writes.clerkUserId = args.clerkUserId === null ? undefined : args.clerkUserId;
    if (args.bio !== undefined) writes.bio = args.bio === null ? undefined : args.bio;
    if (args.niche !== undefined) writes.niche = args.niche === null ? undefined : args.niche;
    if (args.audienceSize !== undefined) writes.audienceSize = args.audienceSize;
    if (args.channels !== undefined) writes.channels = args.channels;
    if (args.websiteUrl !== undefined)
      writes.websiteUrl = args.websiteUrl === null ? undefined : args.websiteUrl;
    if (args.listed !== undefined) writes.listed = args.listed;

    if (existing) {
      await ctx.db.patch(existing._id, writes);
      const updated = (await ctx.db.get(existing._id))!;
      return toProfileRow(updated);
    }

    // Insert: apply PG defaults for any column the writer didn't set.
    const doc = {
      id: crypto.randomUUID(),
      emailLower,
      name,
      audienceSize: (writes.audienceSize as number | undefined) ?? 0,
      channels: (writes.channels as string[] | undefined) ?? [],
      listed: (writes.listed as boolean | undefined) ?? false,
      ...(writes.clerkUserId !== undefined ? { clerkUserId: writes.clerkUserId } : {}),
      ...(writes.bio !== undefined ? { bio: writes.bio } : {}),
      ...(writes.niche !== undefined ? { niche: writes.niche } : {}),
      ...(writes.websiteUrl !== undefined ? { websiteUrl: writes.websiteUrl } : {}),
      createdAt: now,
      updatedAt: now,
    } as ProfileFields;
    await ctx.db.insert('CreatorProfile', doc);
    return toProfileRow(doc);
  },
});

/**
 * Listed creators for the directory, audienceSize DESC (cap 60) — the base read
 * of listCreatorsForSeller. The channel/free-text filters and the "joined?"
 * AffiliatePartner join happen in lib (containment over jsonb + the partner
 * lookup). Returns the full rows so the lib can filter/decorate exactly as
 * before. idx_creator_profile_listed = audienceSize DESC WHERE listed.
 */
export const listListed = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('CreatorProfile')
      .withIndex('by_listed_audience', (q) => q.eq('listed', true))
      .order('desc')
      .take(60);
    return rows.map(toProfileRow);
  },
});

export type { ProfileFields };
