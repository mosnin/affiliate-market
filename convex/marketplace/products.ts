import { query, mutation, type MutationCtx } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

/**
 * Product data access — the Convex replacement for EVERY `.from('Product')` read
 * & write across the app (marketplace catalog, seller/manager CRUD, AI tools,
 * CMA, affiliates, deals, cards, profile picker, admin moderation/verify).
 *
 * Product is a wide, shared table: the same row is read by many domains that stay
 * on Supabase (Deal/Demo/Space/AffiliateProgram/etc.). Per CONVENTIONS each call
 * site swaps ONLY its Product hop; the surrounding non-Product reads stay on
 * Supabase. To keep this surface small and the call-site rewrites mechanical, the
 * reads return the FULL mapped Product row and the caller projects the columns it
 * used to `.select()` — there is no behavioral difference, just a wider payload.
 *
 * Two Postgres UNIQUE indexes encode business rules and are re-implemented as
 * read-then-insert/update inside the create/update mutations:
 *   - idx_product_marketplace_slug UNIQUE(marketplaceSlug) WHERE NOT NULL
 *   - idx_product_space_mls UNIQUE(spaceId, mlsNumber) WHERE NOT NULL
 * Both surface as { error: 'duplicate_slug' | 'duplicate_mls' } so the routes can
 * keep returning their 409s (the routes used the PG 23505 code for this).
 *
 * ON DELETE CASCADE that the schema relied on (deleting a Product removed its
 * License / MarketplaceOrder / ProductPacket / ProductView / Review rows — all
 * THIS domain's tables) is re-implemented as explicit cascade deletes in `remove`.
 * The Deal/Demo `productId` ON DELETE SET NULL is cross-backend (those tables are
 * on Supabase) and is handled by the Product DELETE route, not here.
 */

type ProductFields = {
  id: string;
  spaceId: string;
  address?: string;
  unitNumber?: string;
  city?: string;
  stateRegion?: string;
  postalCode?: string;
  mlsNumber?: string;
  productType?: string;
  beds?: number;
  baths?: number;
  squareFeet?: number;
  lotSizeSqft?: number;
  yearBuilt?: number;
  listPrice?: number;
  listingStatus: string;
  listingUrl?: string;
  photos: unknown;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  companyId?: string;
  assignedSpaceId?: string;
  name?: string;
  tagline?: string;
  longDescription?: string;
  category?: string;
  pricingModel: string;
  priceCents?: number;
  currency: string;
  billingPeriod?: string;
  features: unknown;
  logoUrl?: string;
  websiteUrl?: string;
  published: boolean;
  marketplaceSlug?: string;
  commissionType?: string;
  commissionValue?: number;
  featured: boolean;
  verified: boolean;
};

/**
 * The full legacy Product row. Surfaces `id`, drops _id/_creationTime, and
 * coerces every absent optional back to the SQL NULL the old `select('*')` rows
 * carried — so any caller projecting a column sees `null`, never `undefined`.
 * photos/features default to [] (PG column defaults; never NULL).
 */
function toRow(p: ProductFields) {
  return {
    id: p.id,
    spaceId: p.spaceId,
    address: p.address ?? null,
    unitNumber: p.unitNumber ?? null,
    city: p.city ?? null,
    stateRegion: p.stateRegion ?? null,
    postalCode: p.postalCode ?? null,
    mlsNumber: p.mlsNumber ?? null,
    productType: p.productType ?? null,
    beds: p.beds ?? null,
    baths: p.baths ?? null,
    squareFeet: p.squareFeet ?? null,
    lotSizeSqft: p.lotSizeSqft ?? null,
    yearBuilt: p.yearBuilt ?? null,
    listPrice: p.listPrice ?? null,
    listingStatus: p.listingStatus,
    listingUrl: p.listingUrl ?? null,
    photos: Array.isArray(p.photos) ? p.photos : [],
    notes: p.notes ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    companyId: p.companyId ?? null,
    assignedSpaceId: p.assignedSpaceId ?? null,
    name: p.name ?? null,
    tagline: p.tagline ?? null,
    longDescription: p.longDescription ?? null,
    category: p.category ?? null,
    pricingModel: p.pricingModel,
    priceCents: p.priceCents ?? null,
    currency: p.currency,
    billingPeriod: p.billingPeriod ?? null,
    features: Array.isArray(p.features) ? p.features : [],
    logoUrl: p.logoUrl ?? null,
    websiteUrl: p.websiteUrl ?? null,
    published: p.published,
    marketplaceSlug: p.marketplaceSlug ?? null,
    commissionType: p.commissionType ?? null,
    commissionValue: p.commissionValue ?? null,
    featured: p.featured,
    verified: p.verified,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One product by id (full row), or null. */
export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('Product')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    return p ? toRow(p) : null;
  },
});

/** One product by id, scoped to a space (full row), or null. The spaceId guard
 *  mirrors every `.eq('id').eq('spaceId').maybeSingle()` resolve in the routes. */
export const getByIdInSpace = query({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('Product')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p || p.spaceId !== args.spaceId) return null;
    return toRow(p);
  },
});

/** Full rows for a set of ids (any order). Covers every `.in('id', ids)` join:
 *  name/address decoration, commission overrides, packet/view/order product names. */
export const byIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: ReturnType<typeof toRow>[] = [];
    const seen = new Set<string>();
    for (const id of args.ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const p = await ctx.db
        .query('Product')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique();
      if (p) out.push(toRow(p));
    }
    return out;
  },
});

/** A published product by marketplace slug (full row), or null. PG also required
 *  published=true; we keep that guard. by_marketplace_slug is UNIQUE-backed. */
export const getBySlugPublished = query({
  args: { marketplaceSlug: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query('Product')
      .withIndex('by_marketplace_slug', (q) => q.eq('marketplaceSlug', args.marketplaceSlug))
      .first();
    if (!p || !p.published) return null;
    return toRow(p);
  },
});

/**
 * The marketplace catalog: published, marketplace-listed products, optionally
 * filtered by category, sorted featured-first then updatedAt desc, capped 60.
 * Replaces getPublishedProducts' Supabase query. Text search (name/tagline) the
 * lib applied with `.or(ilike)` stays in lib (it filters the returned rows) so
 * this query has no free-text branch.
 */
export const listPublished = query({
  args: { category: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let rows: Doc<'Product'>[];
    if (args.category !== undefined) {
      rows = await ctx.db
        .query('Product')
        .withIndex('by_published_category', (q) =>
          q.eq('published', true).eq('category', args.category),
        )
        .collect();
    } else {
      rows = await ctx.db
        .query('Product')
        .withIndex('by_published_category', (q) => q.eq('published', true))
        .collect();
    }
    // Only marketplace-listed rows are reachable (PG `.not(marketplaceSlug,is,null)`).
    rows = rows.filter((r) => r.marketplaceSlug != null);
    // featured DESC, then updatedAt DESC (PG order). Booleans: true sorts first.
    rows.sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
    });
    return rows.slice(0, 60).map(toRow);
  },
});

/**
 * Published, marketplace-listed products for one space, newest-updated first.
 * Used by getProductsForSeller AND the seller funnel (which then filters to
 * marketplaceSlug != null itself — we already do). Replaces
 * `.eq('spaceId').eq('published',true).not(marketplaceSlug,is,null).order(updatedAt desc)`.
 */
export const listPublishedForSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Product')
      .withIndex('by_space_updated', (q) => q.eq('spaceId', args.spaceId))
      .order('desc')
      .collect();
    return rows.filter((r) => r.published && r.marketplaceSlug != null).map(toRow);
  },
});

/**
 * A space's products INCLUDING company-pool products assigned to it
 * (spaceId == X OR assignedSpaceId == X). Optional listingStatus filter (single
 * value or a set). Sorted by `order` ('updated' = updatedAt desc, 'created' =
 * createdAt desc). Replaces the seller products GET/page `.or(spaceId,assignedSpaceId)`
 * reads and the AI/CMA space lists. Text search stays in the caller.
 */
export const listForSpace = query({
  args: {
    spaceId: v.string(),
    listingStatusIn: v.optional(v.array(v.string())),
    order: v.optional(v.union(v.literal('updated'), v.literal('created'))),
  },
  handler: async (ctx, args) => {
    const owned = await ctx.db
      .query('Product')
      .withIndex('by_space_updated', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const assigned = await ctx.db
      .query('Product')
      .withIndex('by_assigned_space', (q) => q.eq('assignedSpaceId', args.spaceId))
      .collect();
    // Union, de-duped by id (a row could match both, though spaceId !=
    // assignedSpaceId in practice). PG's OR returned each row once.
    const byId = new Map<string, Doc<'Product'>>();
    for (const r of owned) byId.set(r.id, r);
    for (const r of assigned) byId.set(r.id, r);
    let rows = [...byId.values()];

    if (args.listingStatusIn && args.listingStatusIn.length > 0) {
      const allowed = new Set(args.listingStatusIn);
      rows = rows.filter((r) => allowed.has(r.listingStatus));
    }

    const key = args.order === 'created' ? 'createdAt' : 'updatedAt';
    rows.sort((a, b) => (a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : 0));
    return rows.map(toRow);
  },
});

/** Count a space's products in the given listingStatus set. Replaces the layout's
 *  `.select('id',{count,head}).eq('spaceId').in('listingStatus',[...])`. */
export const countForSpaceByStatus = query({
  args: { spaceId: v.string(), listingStatusIn: v.array(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query('Product')
      .withIndex('by_space_updated', (q) => q.eq('spaceId', args.spaceId))
      .collect();
    const allowed = new Set(args.listingStatusIn);
    return rows.filter((r) => allowed.has(r.listingStatus)).length;
  },
});

/** A company's products, newest-updated first (cap 2000). Manager pool list.
 *  idx_product_company = (companyId, updatedAt DESC). */
export const listForCompany = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('Product')
      .withIndex('by_company_updated', (q) => q.eq('companyId', args.companyId))
      .order('desc')
      .take(2000);
    return rows.map(toRow);
  },
});

/** Published+unverified, marketplace-listed products for the admin moderation
 *  queue, newest-updated first (cap 100). Replaces
 *  `.eq('published',true).eq('verified',false).not(marketplaceSlug,is,null).order(updatedAt desc)`. */
export const listUnverifiedPublished = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('Product')
      .withIndex('by_published_category', (q) => q.eq('published', true))
      .collect();
    const out = rows.filter((r) => !r.verified && r.marketplaceSlug != null);
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return out.slice(0, 100).map(toRow);
  },
});

/** The owning spaceId for a product (nullable), or null when the product is gone.
 *  Used by recordProductView to scope the view row. Returns { spaceId } | null. */
export const spaceForProduct = query({
  args: { productId: v.string() },
  handler: async (ctx, args): Promise<{ spaceId: string | null } | null> => {
    const p = await ctx.db
      .query('Product')
      .withIndex('by_app_id', (q) => q.eq('id', args.productId))
      .unique();
    if (!p) return null;
    return { spaceId: p.spaceId ?? null };
  },
});

/** All Product photos arrays (cap 5000) for the storage-gc sweep. Replaces
 *  `.from('Product').select('photos').limit(5000)`. */
export const allPhotos = query({
  args: {},
  handler: async (ctx): Promise<unknown[]> => {
    const rows = await ctx.db.query('Product').take(5000);
    return rows.map((r) => (Array.isArray(r.photos) ? r.photos : []));
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

/** The sanitised, writable column set. The routes build `out` from their own
 *  validators; we accept it as a typed bag and write only known columns. Money:
 *  priceCents is integer cents, validated upstream — stored verbatim. */
const writableFields = {
  address: v.optional(v.union(v.string(), v.null())),
  unitNumber: v.optional(v.union(v.string(), v.null())),
  city: v.optional(v.union(v.string(), v.null())),
  stateRegion: v.optional(v.union(v.string(), v.null())),
  postalCode: v.optional(v.union(v.string(), v.null())),
  mlsNumber: v.optional(v.union(v.string(), v.null())),
  productType: v.optional(v.union(v.string(), v.null())),
  beds: v.optional(v.union(v.number(), v.null())),
  baths: v.optional(v.union(v.number(), v.null())),
  squareFeet: v.optional(v.union(v.number(), v.null())),
  lotSizeSqft: v.optional(v.union(v.number(), v.null())),
  yearBuilt: v.optional(v.union(v.number(), v.null())),
  listPrice: v.optional(v.union(v.number(), v.null())),
  listingStatus: v.optional(v.string()),
  listingUrl: v.optional(v.union(v.string(), v.null())),
  photos: v.optional(v.any()),
  notes: v.optional(v.union(v.string(), v.null())),
  name: v.optional(v.union(v.string(), v.null())),
  tagline: v.optional(v.union(v.string(), v.null())),
  longDescription: v.optional(v.union(v.string(), v.null())),
  category: v.optional(v.union(v.string(), v.null())),
  pricingModel: v.optional(v.string()),
  priceCents: v.optional(v.union(v.number(), v.null())),
  currency: v.optional(v.string()),
  billingPeriod: v.optional(v.union(v.string(), v.null())),
  features: v.optional(v.any()),
  logoUrl: v.optional(v.union(v.string(), v.null())),
  websiteUrl: v.optional(v.union(v.string(), v.null())),
  published: v.optional(v.boolean()),
  marketplaceSlug: v.optional(v.union(v.string(), v.null())),
  commissionType: v.optional(v.union(v.string(), v.null())),
  commissionValue: v.optional(v.union(v.number(), v.null())),
  featured: v.optional(v.boolean()),
  verified: v.optional(v.boolean()),
  companyId: v.optional(v.union(v.string(), v.null())),
  assignedSpaceId: v.optional(v.union(v.string(), v.null())),
};

/** Convert a writable bag into a Convex patch: `null` removes the optional column
 *  (SQL NULL), a value sets it, `undefined` leaves it alone. listingStatus/
 *  pricingModel/currency are non-null columns so they only ever set. */
function buildPatch(fields: Record<string, unknown>): Record<string, unknown> {
  const NON_NULL = new Set(['listingStatus', 'pricingModel', 'currency', 'published', 'featured', 'verified']);
  const patch: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    if (val === null) {
      if (!NON_NULL.has(k)) patch[k] = undefined; // remove optional column
      continue;
    }
    patch[k] = val;
  }
  return patch;
}

export type ProductWriteResult =
  | { ok: true; product: ReturnType<typeof toRow> }
  | { ok: false; error: 'duplicate_slug' | 'duplicate_mls' | 'not_found' };

/** True if another product already uses this marketplaceSlug (UNIQUE WHERE NOT
 *  NULL). `exceptId` lets an update ignore its own row. */
async function slugTaken(ctx: MutationCtx, slug: string, exceptId: string | null): Promise<boolean> {
  const rows = await ctx.db
    .query('Product')
    .withIndex('by_marketplace_slug', (q) => q.eq('marketplaceSlug', slug))
    .collect();
  return rows.some((r) => r.id !== exceptId);
}

/** True if another product in this space already uses this mlsNumber (UNIQUE
 *  (spaceId, mlsNumber) WHERE NOT NULL). */
async function mlsTaken(
  ctx: MutationCtx,
  spaceId: string,
  mls: string,
  exceptId: string | null,
): Promise<boolean> {
  const rows = await ctx.db
    .query('Product')
    .withIndex('by_space_updated', (q) => q.eq('spaceId', spaceId))
    .collect();
  return rows.some((r) => r.mlsNumber === mls && r.id !== exceptId);
}

/**
 * Create a product. spaceId + the sanitised fields come from the route (it also
 * mints the id when it wants a specific one; we default one otherwise). Defaults
 * match PG columns: listingStatus 'draft' unless given, photos []/features [],
 * pricingModel 'one_time', currency 'usd', published/featured/verified false.
 * Enforces the marketplaceSlug + (spaceId, mlsNumber) UNIQUE indexes before
 * inserting (read-then-insert).
 */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    spaceId: v.string(),
    fields: v.object(writableFields),
  },
  handler: async (ctx, args): Promise<ProductWriteResult> => {
    const f = args.fields as Record<string, unknown>;
    const slug = typeof f.marketplaceSlug === 'string' ? f.marketplaceSlug : null;
    if (slug && (await slugTaken(ctx, slug, null))) {
      return { ok: false, error: 'duplicate_slug' };
    }
    const mls = typeof f.mlsNumber === 'string' ? f.mlsNumber : null;
    if (mls && (await mlsTaken(ctx, args.spaceId, mls, null))) {
      return { ok: false, error: 'duplicate_mls' };
    }

    const now = new Date().toISOString();
    const patch = buildPatch(f);
    const doc = {
      id: args.id ?? crypto.randomUUID(),
      spaceId: args.spaceId,
      listingStatus: (patch.listingStatus as string) ?? 'draft',
      photos: patch.photos ?? [],
      features: patch.features ?? [],
      pricingModel: (patch.pricingModel as string) ?? 'one_time',
      currency: (patch.currency as string) ?? 'usd',
      published: (patch.published as boolean) ?? false,
      featured: (patch.featured as boolean) ?? false,
      verified: (patch.verified as boolean) ?? false,
      createdAt: now,
      updatedAt: now,
      ...patch, // any other sanitised columns (name, priceCents, etc.)
    };
    await ctx.db.insert('Product', doc as any);
    const stored = await ctx.db
      .query('Product')
      .withIndex('by_app_id', (q) => q.eq('id', doc.id))
      .unique();
    return { ok: true, product: toRow(stored!) };
  },
});

/**
 * Update a product by id, scoped to a space. Only provided fields change;
 * updatedAt always bumps. Enforces the two UNIQUE indexes (ignoring this row).
 * Returns not_found when the id isn't in this space (route → 404). Replaces every
 * seller/manager `.update(patch).eq('id').eq('spaceId')`.
 */
export const update = mutation({
  args: {
    id: v.string(),
    spaceId: v.string(),
    fields: v.object(writableFields),
  },
  handler: async (ctx, args): Promise<ProductWriteResult> => {
    const p = await ctx.db
      .query('Product')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p || p.spaceId !== args.spaceId) return { ok: false, error: 'not_found' };

    const f = args.fields as Record<string, unknown>;
    if (typeof f.marketplaceSlug === 'string' && (await slugTaken(ctx, f.marketplaceSlug, p.id))) {
      return { ok: false, error: 'duplicate_slug' };
    }
    if (typeof f.mlsNumber === 'string' && (await mlsTaken(ctx, p.spaceId, f.mlsNumber, p.id))) {
      return { ok: false, error: 'duplicate_mls' };
    }

    const patch = buildPatch(f);
    patch.updatedAt = new Date().toISOString();
    await ctx.db.patch(p._id, patch);
    return { ok: true, product: toRow((await ctx.db.get(p._id))!) };
  },
});

/** Assign (or unassign) a product to a space within a company. target null clears
 *  it. Bumps updatedAt. Manager-only. Returns the full row, or not_found. */
export const setAssignedSpace = mutation({
  args: { id: v.string(), assignedSpaceId: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<ProductWriteResult> => {
    const p = await ctx.db
      .query('Product')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p) return { ok: false, error: 'not_found' };
    await ctx.db.patch(p._id, {
      assignedSpaceId: args.assignedSpaceId === null ? undefined : args.assignedSpaceId,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, product: toRow((await ctx.db.get(p._id))!) };
  },
});

/** Admin: set the platform `verified` trust flag. Returns { id, verified } | null
 *  (route → 404 when null). Only this path writes Product.verified. */
export const setVerified = mutation({
  args: { id: v.string(), verified: v.boolean() },
  handler: async (ctx, args): Promise<{ id: string; verified: boolean } | null> => {
    const p = await ctx.db
      .query('Product')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p) return null;
    await ctx.db.patch(p._id, { verified: args.verified });
    return { id: p.id, verified: args.verified };
  },
});

/**
 * Delete a product by id, scoped to a space, cascading to THIS domain's child
 * rows (License / MarketplaceOrder / ProductPacket / ProductView / Review) the
 * way Postgres ON DELETE CASCADE did. Returns { ok, photos } — the route still
 * owns the storage cleanup (it reverses the photo URLs to keys) and the cross-
 * backend Deal/Demo SET NULL. No-op (ok:false) if the id isn't this space's.
 */
export const remove = mutation({
  args: { id: v.string(), spaceId: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; photos: unknown[] }> => {
    const p = await ctx.db
      .query('Product')
      .withIndex('by_app_id', (q) => q.eq('id', args.id))
      .unique();
    if (!p || p.spaceId !== args.spaceId) return { ok: false, photos: [] };

    const photos = Array.isArray(p.photos) ? p.photos : [];

    // Cascade: orders for this product, and their licenses + refund requests.
    const orders = await ctx.db
      .query('MarketplaceOrder')
      .withIndex('by_product', (q) => q.eq('productId', p.id))
      .collect();
    for (const o of orders) {
      const refunds = await ctx.db
        .query('RefundRequest')
        .withIndex('by_order', (q) => q.eq('orderId', o.id))
        .collect();
      for (const r of refunds) await ctx.db.delete(r._id);
      await ctx.db.delete(o._id);
    }

    // Licenses reference productId directly (PG License_productId_fkey CASCADE).
    // License has no by-product index (it's keyed by order/buyer/key), so for a
    // product delete we scan and match productId — this is the only place that
    // needs it, and a product delete is rare + admin-driven.
    const licenses = await ctx.db.query('License').collect();
    for (const l of licenses) {
      if (l.productId === p.id) await ctx.db.delete(l._id);
    }

    // Packets + views for this product.
    const packets = await ctx.db
      .query('ProductPacket')
      .withIndex('by_product_created', (q) => q.eq('productId', p.id))
      .collect();
    for (const pk of packets) await ctx.db.delete(pk._id);

    const views = await ctx.db
      .query('ProductView')
      .withIndex('by_product_created', (q) => q.eq('productId', p.id))
      .collect();
    for (const vrow of views) await ctx.db.delete(vrow._id);

    // Reviews for this product (both published + hidden).
    const reviews = await ctx.db
      .query('Review')
      .withIndex('by_product_buyer', (q) => q.eq('productId', p.id))
      .collect();
    for (const rv of reviews) await ctx.db.delete(rv._id);

    await ctx.db.delete(p._id);
    return { ok: true, photos };
  },
});
