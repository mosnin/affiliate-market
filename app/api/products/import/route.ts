import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { convex, api } from '@/lib/convex-server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import { isValidProductType } from '@/lib/products';
import { logger } from '@/lib/logger';

const MAX_ROWS = 200;

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped "" quotes,
 * commas/newlines inside quotes, and CRLF. Returns rows of string cells.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/**
 * Bulk-import a product catalog into the seller's marketplace presence. CSV
 * columns: name,tagline,category,priceCents,pricingModel (header row required).
 *
 * Every row is inserted as a DRAFT (published:false, listingStatus:'draft')
 * scoped to the caller's own space — the seller reviews and publishes from the
 * product surface. Nothing goes live on the marketplace from an import.
 */
export async function POST(req: NextRequest) {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;
  const { space } = result;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const csv = typeof body.csv === 'string' ? body.csv : '';
  if (!csv.trim()) {
    return NextResponse.json(
      { error: 'Paste a CSV with name,tagline,category,priceCents,pricingModel columns.' },
      { status: 400 },
    );
  }

  const rows = parseCsv(csv);
  if (rows.length === 0) {
    return NextResponse.json({ error: 'No header row found.' }, { status: 400 });
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const nameIdx = col('name');
  const taglineIdx = col('tagline');
  const categoryIdx = col('category');
  const priceIdx = col('pricecents');
  const pricingIdx = col('pricingmodel');
  if (nameIdx === -1) {
    return NextResponse.json({ error: 'CSV must have a "name" column.' }, { status: 400 });
  }

  const dataRows = rows.slice(1);
  if (dataRows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `Too many rows. Import up to ${MAX_ROWS} at a time.` },
      { status: 400 },
    );
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const line = i + 2;
    if (row.every((c) => c.trim() === '')) continue;

    const name = (row[nameIdx] ?? '').trim().slice(0, 200);
    if (!name) {
      skipped++;
      if (errors.length < 50) errors.push(`Row ${line}: missing name.`);
      continue;
    }

    const tagline = taglineIdx >= 0 ? (row[taglineIdx] ?? '').trim().slice(0, 200) : '';

    // Category is optional; if present it must be a known product type.
    let category: string | null = null;
    if (categoryIdx >= 0) {
      const raw = (row[categoryIdx] ?? '').trim().toLowerCase();
      if (raw) {
        if (isValidProductType(raw)) category = raw;
        else {
          skipped++;
          if (errors.length < 50) errors.push(`Row ${line}: unknown category "${raw}".`);
          continue;
        }
      }
    }

    // priceCents — integer cents, optional.
    let priceCents: number | null = null;
    if (priceIdx >= 0) {
      const raw = (row[priceIdx] ?? '').trim();
      if (raw) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
          skipped++;
          if (errors.length < 50) errors.push(`Row ${line}: priceCents must be a whole number of cents.`);
          continue;
        }
        priceCents = n;
      }
    }

    // pricingModel — one_time | subscription, defaults to one_time.
    let pricingModel: 'one_time' | 'subscription' = 'one_time';
    if (pricingIdx >= 0) {
      const raw = (row[pricingIdx] ?? '').trim().toLowerCase();
      if (raw) {
        if (raw === 'one_time' || raw === 'subscription') pricingModel = raw;
        else {
          skipped++;
          if (errors.length < 50) errors.push(`Row ${line}: pricingModel must be "one_time" or "subscription".`);
          continue;
        }
      }
    }

    const base = slugify(name) || 'product';
    const marketplaceSlug = `${base}-${crypto.randomUUID().slice(0, 6)}`;

    const result = await convex().mutation(api.marketplace.products.create, {
      id: crypto.randomUUID(),
      spaceId: space.id,
      fields: {
        name,
        address: name, // legacy column kept in sync (mirrors products POST)
        tagline: tagline || null,
        category,
        priceCents,
        pricingModel,
        currency: 'usd',
        published: false,
        listingStatus: 'draft',
        marketplaceSlug,
        photos: [],
      },
    });

    if (!result.ok) {
      skipped++;
      logger.warn('[products/import] insert failed', { spaceId: space.id, line, error: result.error });
      if (errors.length < 50) errors.push(`Row ${line}: could not import "${name}".`);
      continue;
    }
    imported++;
  }

  return NextResponse.json({ imported, skipped, errors });
}
