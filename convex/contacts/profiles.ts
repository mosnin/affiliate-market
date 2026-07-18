import { query, mutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * AIUserProfile data access — the seller's onboarding-built persona that
 * personalizes the agent. Convex replacement for every `.from('AIUserProfile')`
 * op: GET /api/ai-profile (read by spaceId), PUT /api/ai-profile (upsert by
 * spaceId), and onboarding's save_seller_profile (upsert by spaceId).
 *
 * UNIQUE(spaceId) — one profile per space — is the real invariant. The PG
 * `.upsert(payload, { onConflict: 'spaceId' })` is re-implemented as
 * read-by-space → patch-or-insert inside ONE serializable mutation (stronger than
 * the old non-atomic upsert). businessFocus/leadSources are text[] (default {}).
 *
 * NOTE on keying: the Wave-A brief said AIUserProfile is "per user (by userId)",
 * but the live schema has NO userId column — it's keyed by spaceId everywhere.
 * Indexed/queried by_space accordingly.
 *
 * No money. No cross-domain writes.
 */

type ProfileFields = {
  id: string;
  spaceId: string;
  displayName?: string;
  businessFocus: string[];
  yearsExperience?: number;
  workingStyle?: string;
  communicationTone?: string;
  currentGoals?: string;
  quirksAndPreferences?: string;
  agentPersonalizationNote?: string;
  createdAt: string;
  updatedAt: string;
  role?: string;
  zipCode?: string;
  leadSources: string[];
};

/** Full AIUserProfile row. Surfaces `id`, coerces absent optionals → SQL NULL;
 *  businessFocus/leadSources default [] (NOT NULL arrays in PG). */
function toRow(p: ProfileFields) {
  return {
    id: p.id,
    spaceId: p.spaceId,
    displayName: p.displayName ?? null,
    businessFocus: Array.isArray(p.businessFocus) ? p.businessFocus : [],
    yearsExperience: p.yearsExperience ?? null,
    workingStyle: p.workingStyle ?? null,
    communicationTone: p.communicationTone ?? null,
    currentGoals: p.currentGoals ?? null,
    quirksAndPreferences: p.quirksAndPreferences ?? null,
    agentPersonalizationNote: p.agentPersonalizationNote ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    role: p.role ?? null,
    zipCode: p.zipCode ?? null,
    leadSources: Array.isArray(p.leadSources) ? p.leadSources : [],
  };
}

// ── Read ─────────────────────────────────────────────────────────────────────

/** The profile for a space, or null. GET /api/ai-profile (`.eq('spaceId').maybeSingle()`). */
export const getForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('AIUserProfile')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();
    return p ? toRow(p) : null;
  },
});

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Upsert the space's profile (UNIQUE(spaceId)): read by space, patch the existing
 * row or insert a new one — one serializable mutation, replacing both
 * `.upsert(..., { onConflict: 'spaceId' })` call sites (ai-profile PUT, onboarding
 * save_seller_profile).
 *
 * PG-upsert semantics: only the columns present in `patch` are written (the routes
 * build the payload with "only include defined fields"); `null` clears a column.
 * On insert, arrays absent from `patch` default to [] and timestamps are stamped.
 * On update we always refresh updatedAt. Returns the resulting row (the routes
 * return `data[0]`).
 */
export const upsertForSpace = mutation({
  args: {
    spaceId: v.string(),
    patch: v.object({
      displayName: v.optional(v.union(v.string(), v.null())),
      businessFocus: v.optional(v.array(v.string())),
      yearsExperience: v.optional(v.union(v.number(), v.null())),
      workingStyle: v.optional(v.union(v.string(), v.null())),
      communicationTone: v.optional(v.union(v.string(), v.null())),
      currentGoals: v.optional(v.union(v.string(), v.null())),
      quirksAndPreferences: v.optional(v.union(v.string(), v.null())),
      agentPersonalizationNote: v.optional(v.union(v.string(), v.null())),
      role: v.optional(v.union(v.string(), v.null())),
      zipCode: v.optional(v.union(v.string(), v.null())),
      leadSources: v.optional(v.array(v.string())),
    }),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const existing = await ctx.db
      .query('AIUserProfile')
      .withIndex('by_space', (q) => q.eq('spaceId', args.spaceId))
      .unique();

    // Normalize the patch: drop undefined; null → undefined (clears column in Convex).
    const writable: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(args.patch)) {
      if (val === undefined) continue;
      writable[k] = val === null ? undefined : val;
    }

    if (existing) {
      await ctx.db.patch(existing._id, { ...writable, updatedAt: now });
      const updated = (await ctx.db.get(existing._id))!;
      return toRow(updated);
    }

    // Insert: arrays default [] when not supplied; stamp created/updated.
    const doc = {
      id: crypto.randomUUID(),
      spaceId: args.spaceId,
      businessFocus: (args.patch.businessFocus ?? []) as string[],
      leadSources: (args.patch.leadSources ?? []) as string[],
      ...writable,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('AIUserProfile', doc);
    return toRow(doc as ProfileFields);
  },
});
