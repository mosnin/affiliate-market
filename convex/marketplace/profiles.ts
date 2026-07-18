import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * ProfilePage data access — the Convex replacement for the `.from('ProfilePage')`
 * reads & upserts in the profile-page routes (config GET/PATCH, cover-photo,
 * profile-photo), the public surfaces (apply / book / demo / public page), and
 * the storage-gc sweep.
 *
 * These routes also touch SpaceSetting / Space / Product — all stay where they
 * belong: SpaceSetting/Space on Supabase, Product via marketplace.products. Only
 * the ProfilePage hops move here. Image upload/sign/sanitise stays in the routes.
 *
 * ProfilePage_spaceId_key UNIQUE(spaceId): exactly one profile page per space.
 * Every write is an upsert-on-spaceId (PG `.upsert(..., { onConflict: 'spaceId' })`),
 * re-implemented as read-by-space-then-insert-or-patch inside one serializable
 * mutation — so a concurrent first-write can't create two rows.
 */

type ProfileFields = {
  id: string;
  spaceId: string;
  enabled: boolean;
  headline?: string;
  showIntake: boolean;
  showDemos: boolean;
  showProducts: boolean;
  customLinks: unknown;
  createdAt: string;
  updatedAt: string;
  videos: unknown;
  coverPhotoUrl?: string;
  profilePhotoUrl?: string;
  featuredProductIds: string[];
};

/** The full legacy ProfilePage row (the columns the GET `SELECT` carried, plus
 *  ids). Surfaces id, coerces absent optionals to SQL NULL; array/jsonb columns
 *  default to []/[] (PG defaults, never NULL). */
function toRow(p: ProfileFields) {
  return {
    id: p.id,
    spaceId: p.spaceId,
    enabled: p.enabled,
    headline: p.headline ?? null,
    showIntake: p.showIntake,
    showDemos: p.showDemos,
    showProducts: p.showProducts,
    customLinks: Array.isArray(p.customLinks) ? p.customLinks : [],
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    videos: Array.isArray(p.videos) ? p.videos : [],
    coverPhotoUrl: p.coverPhotoUrl ?? null,
    profilePhotoUrl: p.profilePhotoUrl ?? null,
    featuredProductIds: Array.isArray(p.featuredProductIds) ? p.featuredProductIds : [],
  };
}

/** The single profile page for a space (full row), or null when unset. The route
 *  merges this over its DEFAULTS, exactly as it did the Supabase `data ?? {}`. */
export const getBySpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('ProfilePage')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .first();
    return p ? toRow(p) : null;
  },
});

/** The set of these photo KEYS still referenced by some ProfilePage cover/profile
 *  photo — the storage-gc "do not delete" guard. Replaces the two
 *  `.in('coverPhotoUrl', candidates)` / `.in('profilePhotoUrl', candidates)`
 *  reads. Returns the referenced keys (a subset of `candidates`). */
export const referencedPhotoKeys = query({
  args: { candidates: v.array(v.string()), field: v.union(v.literal('cover'), v.literal('profile')) },
  handler: async (ctx, args): Promise<string[]> => {
    if (args.candidates.length === 0) return [];
    const wanted = new Set(args.candidates);
    const rows = await ctx.db.query('ProfilePage').collect();
    const referenced = new Set<string>();
    for (const r of rows) {
      const val = args.field === 'cover' ? r.coverPhotoUrl : r.profilePhotoUrl;
      if (val && wanted.has(val)) referenced.add(val);
    }
    return [...referenced];
  },
});

/** The writable ProfilePage columns the PATCH/photo routes set. All optional;
 *  only provided keys change. Photo fields are tri-state (null clears). */
const writableFields = {
  enabled: v.optional(v.boolean()),
  headline: v.optional(v.union(v.string(), v.null())),
  showIntake: v.optional(v.boolean()),
  showDemos: v.optional(v.boolean()),
  showProducts: v.optional(v.boolean()),
  customLinks: v.optional(v.any()),
  videos: v.optional(v.any()),
  coverPhotoUrl: v.optional(v.union(v.string(), v.null())),
  profilePhotoUrl: v.optional(v.union(v.string(), v.null())),
  featuredProductIds: v.optional(v.array(v.string())),
};

/**
 * Upsert the space's profile page (the UNIQUE(spaceId) `.upsert(onConflict:spaceId)`).
 * On first write we INSERT with PG column defaults for any field not provided
 * (enabled/showIntake/showDemos/showProducts true, customLinks/videos []/[],
 * featuredProductIds {}); on a subsequent write we PATCH only the provided fields.
 * Photo/headline fields are tri-state (null clears the column). updatedAt always
 * bumps. Returns the full row (the GET-shaped SELECT the routes hand back).
 */
export const upsert = mutation({
  args: { spaceId: v.string(), fields: v.object(writableFields) },
  handler: async (ctx, args) => {
    const f = args.fields as Record<string, unknown>;
    const now = new Date().toISOString();

    const existing = await ctx.db
      .query('ProfilePage')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .first();

    if (!existing) {
      // INSERT path — apply provided values over PG defaults. null = leave the
      // optional column unset (== SQL NULL).
      const doc: Record<string, unknown> = {
        id: crypto.randomUUID(),
        spaceId: args.spaceId,
        enabled: typeof f.enabled === 'boolean' ? f.enabled : true,
        showIntake: typeof f.showIntake === 'boolean' ? f.showIntake : true,
        showDemos: typeof f.showDemos === 'boolean' ? f.showDemos : true,
        showProducts: typeof f.showProducts === 'boolean' ? f.showProducts : true,
        customLinks: Array.isArray(f.customLinks) ? f.customLinks : [],
        videos: Array.isArray(f.videos) ? f.videos : [],
        featuredProductIds: Array.isArray(f.featuredProductIds) ? f.featuredProductIds : [],
        createdAt: now,
        updatedAt: now,
      };
      if (typeof f.headline === 'string') doc.headline = f.headline;
      if (typeof f.coverPhotoUrl === 'string') doc.coverPhotoUrl = f.coverPhotoUrl;
      if (typeof f.profilePhotoUrl === 'string') doc.profilePhotoUrl = f.profilePhotoUrl;
      await ctx.db.insert('ProfilePage', doc as unknown as ProfileFields);
      const stored = await ctx.db
        .query('ProfilePage')
        .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
        .first();
      return toRow(stored!);
    }

    // PATCH path — only provided fields change; null clears tri-state columns.
    const patch: Record<string, unknown> = { updatedAt: now };
    for (const key of ['enabled', 'showIntake', 'showDemos', 'showProducts'] as const) {
      if (typeof f[key] === 'boolean') patch[key] = f[key];
    }
    if (Array.isArray(f.customLinks)) patch.customLinks = f.customLinks;
    if (Array.isArray(f.videos)) patch.videos = f.videos;
    if (Array.isArray(f.featuredProductIds)) patch.featuredProductIds = f.featuredProductIds;
    if (f.headline !== undefined) patch.headline = f.headline === null ? undefined : f.headline;
    if (f.coverPhotoUrl !== undefined)
      patch.coverPhotoUrl = f.coverPhotoUrl === null ? undefined : f.coverPhotoUrl;
    if (f.profilePhotoUrl !== undefined)
      patch.profilePhotoUrl = f.profilePhotoUrl === null ? undefined : f.profilePhotoUrl;

    await ctx.db.patch(existing._id, patch);
    return toRow((await ctx.db.get(existing._id))!);
  },
});
