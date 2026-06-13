import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
import { requireSpaceOwner } from '@/lib/api-auth';
import { logger } from '@/lib/logger';
import { isValidListingStatus, isValidProductType } from '@/lib/products';

/**
 * Shared input sanitiser. Accepts a loose body and returns an object safe to
 * insert/update. Unknown fields are ignored. Numeric fields are coerced and
 * validated; enum fields are validated against their canonical set.
 */
function sanitiseBody(body: Record<string, unknown>, mode: 'create' | 'update') {
  const out: Record<string, unknown> = {};
  const errors: string[] = [];

  function numberField(key: string, { min, max, integer }: { min?: number; max?: number; integer?: boolean } = {}) {
    if (!(key in body)) return;
    const raw = body[key];
    if (raw === null || raw === '') { out[key] = null; return; }
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
    if (!isFinite(n)) { errors.push(`Invalid ${key}`); return; }
    if (integer && !Number.isInteger(n)) { errors.push(`${key} must be a whole number`); return; }
    if (min != null && n < min) { errors.push(`${key} must be ≥ ${min}`); return; }
    if (max != null && n > max) { errors.push(`${key} must be ≤ ${max}`); return; }
    out[key] = n;
  }

  function stringField(key: string, maxLen: number) {
    if (!(key in body)) return;
    const raw = body[key];
    if (raw === null || raw === '') { out[key] = null; return; }
    out[key] = String(raw).trim().slice(0, maxLen);
  }

  // A display name is required on create — accept `name` (software products)
  // or the legacy `address` field, and keep both columns in sync so older
  // rows/queries that still read `address` render something sensible.
  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 200)
      : typeof body.address === 'string' && body.address.trim()
        ? body.address.trim().slice(0, 200)
        : '';
  if (name) {
    out.name = name;
    out.address = name;
  } else if (mode === 'create') {
    errors.push('name is required');
  }

  stringField('unitNumber', 50);
  stringField('city', 120);
  stringField('stateRegion', 120);
  stringField('postalCode', 20);
  stringField('mlsNumber', 60);
  stringField('listingUrl', 1000);
  stringField('notes', 5000);

  numberField('beds', { min: 0, max: 200 });
  numberField('baths', { min: 0, max: 200 });
  numberField('squareFeet', { min: 0, max: 10_000_000, integer: true });
  numberField('lotSizeSqft', { min: 0, max: 100_000_000, integer: true });
  numberField('yearBuilt', { min: 1600, max: 2200, integer: true });
  numberField('listPrice', { min: 0, max: 10_000_000_000 });

  if ('productType' in body) {
    if (body.productType === null || body.productType === '') out.productType = null;
    else if (isValidProductType(body.productType)) out.productType = body.productType;
    else errors.push('Invalid productType');
  }

  if ('listingStatus' in body) {
    if (isValidListingStatus(body.listingStatus)) out.listingStatus = body.listingStatus;
    else errors.push('Invalid listingStatus');
  }

  if ('photos' in body) {
    if (!Array.isArray(body.photos)) errors.push('photos must be an array');
    else {
      const arr = (body.photos as unknown[])
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter((x) => x.length > 0 && x.length <= 1000)
        .slice(0, 20);
      out.photos = arr;
    }
  }

  // ── Software product fields (marketplace listing) ──────────────────────────
  stringField('tagline', 200);
  stringField('longDescription', 20_000);
  stringField('logoUrl', 1000);
  stringField('websiteUrl', 1000);

  if ('category' in body) {
    if (body.category === null || body.category === '') out.category = null;
    else if (isValidProductType(body.category)) out.category = body.category;
    else errors.push('Invalid category');
  }

  if ('pricingModel' in body) {
    if (body.pricingModel === 'one_time' || body.pricingModel === 'subscription') {
      out.pricingModel = body.pricingModel;
    } else errors.push('Invalid pricingModel');
  }

  if ('billingPeriod' in body) {
    if (body.billingPeriod === null || body.billingPeriod === '') out.billingPeriod = null;
    else if (body.billingPeriod === 'monthly' || body.billingPeriod === 'yearly') {
      out.billingPeriod = body.billingPeriod;
    } else errors.push('Invalid billingPeriod');
  }

  numberField('priceCents', { min: 0, max: 100_000_000_00, integer: true });

  // Per-product commission override (null = inherit the program default).
  if ('commissionType' in body) {
    if (body.commissionType === null || body.commissionType === '') out.commissionType = null;
    else if (body.commissionType === 'percent' || body.commissionType === 'flat') {
      out.commissionType = body.commissionType;
    } else errors.push('Invalid commissionType');
  }
  if ('commissionValue' in body) {
    if (body.commissionValue === null || body.commissionValue === '') out.commissionValue = null;
    else {
      const v = Number(body.commissionValue);
      if (!Number.isFinite(v) || v < 0) errors.push('commissionValue must be ≥ 0');
      else out.commissionValue = v;
    }
  }

  if ('features' in body) {
    if (!Array.isArray(body.features)) errors.push('features must be an array');
    else {
      out.features = (body.features as unknown[])
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter((x) => x.length > 0 && x.length <= 300)
        .slice(0, 30);
    }
  }

  if ('published' in body) {
    if (typeof body.published === 'boolean') out.published = body.published;
    else errors.push('published must be a boolean');
  }

  if ('marketplaceSlug' in body) {
    if (body.marketplaceSlug === null || body.marketplaceSlug === '') {
      out.marketplaceSlug = null;
    } else {
      const slug = String(body.marketplaceSlug)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
      if (slug) out.marketplaceSlug = slug;
      else errors.push('Invalid marketplaceSlug');
    }
  }

  // Publishing requires a marketplace identity — generate one from the name
  // rather than failing the common "publish" toggle path.
  if (out.published === true && !out.marketplaceSlug && mode === 'create') {
    const base = String(out.name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100);
    if (base) out.marketplaceSlug = `${base}-${crypto.randomUUID().slice(0, 6)}`;
  }

  return { out, errors };
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  const search = (req.nextUrl.searchParams.get('search') ?? '').trim().slice(0, 200);

  let query = supabase
    .from('Product')
    .select('*')
    // The seller's own products PLUS any company-pool product assigned
    // to their space. space.id is a controlled UUID, safe in the or-filter.
    .or(`spaceId.eq.${space.id},assignedSpaceId.eq.${space.id}`)
    .order('updatedAt', { ascending: false })
    .limit(500);

  if (search) {
    // Escape PostgREST wildcards + strip filter-breaking characters.
    const escaped = search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const sanitized = escaped.replace(/[,()]/g, '');
    const pattern = `%${sanitized}%`;
    query = query.or(`address.ilike.${pattern},mlsNumber.ilike.${pattern},city.ilike.${pattern}`);
  }

  const { data, error } = await query;
  if (error) {
    logger.error('[products/GET] query failed', { spaceId: space.id }, error);
    return NextResponse.json({ error: 'Failed to fetch products' }, { status: 500 });
  }
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const slug = typeof body.slug === 'string' ? body.slug : null;
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  const { out, errors } = sanitiseBody(body, 'create');
  if (errors.length) return NextResponse.json({ error: errors.join(', ') }, { status: 400 });

  const insert = {
    id: crypto.randomUUID(),
    spaceId: space.id,
    listingStatus: out.listingStatus ?? 'active',
    photos: out.photos ?? [],
    ...out,
  };

  const { data, error } = await supabase.from('Product').insert(insert).select().single();
  if (error) {
    // 23505 = unique_violation (e.g. duplicate MLS #).
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'A product with that MLS number already exists' }, { status: 409 });
    }
    logger.error('[products/POST] insert failed', { spaceId: space.id }, error);
    return NextResponse.json({ error: 'Failed to create product' }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

export { sanitiseBody as _sanitiseProductBody };
