import { NextRequest, NextResponse } from 'next/server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import { createPartner } from '@/lib/affiliates/partners';

const MAX_ROWS = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped "" quotes,
 * commas/newlines inside quotes, and CRLF. Returns rows of string cells.
 * Kept inline (no lib dependency) — it only has to read flat name/email CSVs.
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
  // flush trailing cell/row (no terminating newline)
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * Bulk-import an existing affiliate list (FirstPromoter/Rewardful export, etc.)
 * into the seller's program. CSV columns: name,email (header row required).
 *
 * Each valid row goes through createPartner with invitedBySeller:true, so the
 * partner lands approved, gets a referral link, and receives an invite email —
 * idempotent on (space, email), so re-importing the same list is safe.
 */
export async function POST(req: NextRequest) {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const csv = typeof body.csv === 'string' ? body.csv : '';
  if (!csv.trim()) {
    return NextResponse.json({ error: 'Paste a CSV with name,email columns.' }, { status: 400 });
  }

  const rows = parseCsv(csv);
  if (rows.length === 0) {
    return NextResponse.json({ error: 'No header row found.' }, { status: 400 });
  }

  // Header row → column index. Accept name/email in any order, case-insensitive.
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const nameIdx = header.indexOf('name');
  const emailIdx = header.indexOf('email');
  if (emailIdx === -1) {
    return NextResponse.json(
      { error: 'CSV must have an "email" column (and ideally "name").' },
      { status: 400 },
    );
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
  const seen = new Set<string>();

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const line = i + 2; // 1-based, +1 for the header
    if (row.every((c) => c.trim() === '')) continue; // blank line

    const email = (row[emailIdx] ?? '').trim().toLowerCase();
    const name = (nameIdx >= 0 ? (row[nameIdx] ?? '').trim() : '') || email.split('@')[0];

    if (!EMAIL_RE.test(email)) {
      skipped++;
      if (errors.length < 50) errors.push(`Row ${line}: invalid email "${email || '(blank)'}".`);
      continue;
    }
    if (seen.has(email)) {
      skipped++; // duplicate within this same upload
      continue;
    }
    seen.add(email);

    const created = await createPartner({
      spaceId: result.space.id,
      name,
      email,
      invitedBySeller: true,
    });
    if (!created) {
      skipped++;
      if (errors.length < 50) errors.push(`Row ${line}: could not import "${email}".`);
      continue;
    }
    // created.created === false → already in the program; counts as a no-op skip.
    if (created.created) imported++;
    else skipped++;
  }

  return NextResponse.json({ imported, skipped, errors });
}
