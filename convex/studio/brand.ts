import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * StudioBrand data access — the Convex replacement for the Supabase reads/writes
 * in app/api/studio/brand/route.ts and the brand-color read in
 * lib/studio/generate.ts. One brand kit row per space.
 */

const handlesValidator = v.object({
  instagram: v.optional(v.string()),
  facebook: v.optional(v.string()),
  linkedin: v.optional(v.string()),
});

/** The palette only — folded into the generation prompt to keep output on-brand. */
export const getBrandColors = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const row = await ctx.db
      .query('StudioBrand')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    return row?.colors ?? [];
  },
});

/** The full brand kit (palette, voice, handles) or null if the space has none. */
export const getBrand = query({
  args: { spaceId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    colors: string[];
    voice: string;
    handles: Record<string, unknown>;
  } | null> => {
    const row = await ctx.db
      .query('StudioBrand')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    if (!row) return null;
    return {
      colors: row.colors ?? [],
      voice: row.voice ?? '',
      handles: (row.handles as Record<string, unknown> | null) ?? {},
    };
  },
});

/**
 * Upsert the brand kit for a space. Replaces the PG upsert(onConflict:'spaceId').
 * Read-then-insert-or-patch is serializable in Convex, preserving the
 * one-row-per-space invariant the old unique index gave us.
 */
export const upsertBrand = mutation({
  args: {
    spaceId: v.string(),
    colors: v.array(v.string()),
    voice: v.string(),
    handles: handlesValidator,
  },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query('StudioBrand')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    const now = new Date().toISOString();
    if (existing) {
      await ctx.db.patch(existing._id, {
        colors: args.colors,
        voice: args.voice,
        handles: args.handles,
        updatedAt: now,
      });
      return;
    }
    await ctx.db.insert('StudioBrand', {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      colors: args.colors,
      // fonts/handles are NOT NULL with a '{}' default in PG; the brand route
      // never sets fonts, so default it to an empty object here.
      fonts: {},
      handles: args.handles,
      voice: args.voice,
      createdAt: now,
      updatedAt: now,
    });
  },
});
