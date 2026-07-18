import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireSpaceOwner } from '@/lib/api-auth';
import { syncContact } from '@/lib/vectorize';
import { notifyNewContact } from '@/lib/notify';
import { fireAgentTrigger } from '@/lib/agent/fire-trigger';
import type { Contact } from '@/lib/types';

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  const search = req.nextUrl.searchParams.get('search') ?? '';
  const type = req.nextUrl.searchParams.get('type');
  // Snooze hygiene: by default hide currently-snoozed contacts from the main
  // People view. Callers that need them (e.g. a "Snoozed" tab, or the
  // command palette fuzzy search) can pass ?includeSnoozed=1.
  const includeSnoozed = req.nextUrl.searchParams.get('includeSnoozed') === '1';
  const onlySnoozed = req.nextUrl.searchParams.get('onlySnoozed') === '1';

  // Pagination: default 500, max 1000
  const limitParam = parseInt(req.nextUrl.searchParams.get('limit') ?? '500', 10);
  const offsetParam = parseInt(req.nextUrl.searchParams.get('offset') ?? '0', 10);
  const limit = Math.min(Math.max(1, limitParam || 500), 1000);
  const offset = Math.max(0, offsetParam || 0);

  // listForSpace replicates the same surface the SQL built: companyId IS NULL gate
  // (excludeCompanyLeads), snooze hygiene (includeSnoozed/onlySnoozed), forgiving
  // multi-token AND search over name/email/phone/preferences, type filter, and
  // newest-first offset/limit paging.
  let contacts;
  try {
    contacts = await convex().query(api.contacts.contacts.listForSpace, {
      spaceId: space.id,
      excludeCompanyLeads: true,
      includeSnoozed,
      onlySnoozed,
      ...(search ? { search } : {}),
      ...(type && type !== 'ALL' ? { type } : {}),
      limit,
      offset,
    });
  } catch (error) {
    console.error('[contacts/GET] query error:', error);
    return NextResponse.json({ error: 'Failed to fetch contacts' }, { status: 500 });
  }

  return NextResponse.json(contacts as unknown as Contact[]);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { slug, name, email, phone, budget, preferences, products, address, notes, type, tags } = body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  if (name.length > 200) {
    return NextResponse.json({ error: 'name must be 200 characters or fewer' }, { status: 400 });
  }

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { space } = auth;

  const id = crypto.randomUUID();
  const budgetVal = budget != null && budget !== '' ? parseFloat(budget) : null;
  if (budgetVal !== null && (Number.isNaN(budgetVal) || budgetVal < 0)) {
    return NextResponse.json({ error: 'Invalid budget' }, { status: 400 });
  }

  // Match PATCH's structural bounds — name was the only field validated here,
  // so everything else could land in the DB at any size.
  const emailVal = email ? String(email).trim().slice(0, 254) : null;
  const phoneVal = phone ? String(phone).trim().slice(0, 20) : null;
  const addressVal = address ? String(address).trim().slice(0, 500) : null;
  const notesVal = notes ? String(notes).trim().slice(0, 5000) : null;
  const preferencesVal = preferences ? String(preferences).trim().slice(0, 5000) : null;

  // Dedupe by email (case-insensitive) within this space. The intake flow
  // and CSV imports occasionally re-create the same person — better to
  // hand back the existing record than make the seller merge later.
  // No new DB constraint: case-mismatched emails would be rejected by a
  // unique index, which may not be desired across all data.
  if (emailVal) {
    try {
      const existing = await convex().query(api.contacts.contacts.findByEmailInSpace, {
        spaceId: space.id,
        email: emailVal,
      });
      if (existing) {
        return NextResponse.json(
          { id: existing.id, duplicate: true },
          { status: 200 },
        );
      }
    } catch {
      // Match the old behavior: a failed dedup probe does not block creation.
    }
  }

  const propsVal = Array.isArray(products)
    ? products
        .filter((p: unknown): p is string => typeof p === 'string')
        .slice(0, 50)
        .map((p) => p.slice(0, 500))
    : [];
  const tagsVal = Array.isArray(tags)
    ? tags
        .filter((t: unknown): t is string => typeof t === 'string')
        .slice(0, 50)
        .map((t) => t.slice(0, 100))
    : [];

  const VALID_TYPES = ['QUALIFICATION', 'DEMO', 'APPLICATION'] as const;
  const contactType = VALID_TYPES.includes(type) ? type : 'QUALIFICATION';

  let contact;
  try {
    contact = await convex().mutation(api.contacts.contacts.create, {
      id,
      spaceId: space.id,
      name: name.trim().slice(0, 200),
      email: emailVal,
      phone: phoneVal,
      address: addressVal,
      notes: notesVal,
      type: contactType,
      budget: budgetVal,
      preferences: preferencesVal,
      products: propsVal,
      tags: tagsVal,
    });
  } catch (error) {
    console.error('[contacts/POST] insert error:', error);
    return NextResponse.json({ error: 'Failed to create contact' }, { status: 500 });
  }

  // Async vectorization — don't block the response. Convex returns string
  // timestamps; the legacy Contact type annotates them as Date (pre-migration
  // fiction). Cast through unknown — syncContact reads ids/strings, not Dates.
  syncContact(contact as unknown as Contact).catch(console.error);

  // SMS notification for new leads
  try {
    await notifyNewContact({
      spaceId: space.id,
      contactName: name,
      contactPhone: phoneVal,
      contactEmail: emailVal,
      tags: tagsVal,
    });
  } catch (e) { console.error('[contacts] notification failed:', e); }

  // Fire the agent trigger so Cola can act on the new lead in real time
  // instead of waiting for the 4-hour cron sweep. Never lets a trigger
  // failure fail the response — the contact write is what was requested.
  try {
    await fireAgentTrigger({ spaceId: space.id, event: 'new_lead', contactId: contact.id });
  } catch (e) { console.error('[contacts] agent trigger failed:', e); }

  return NextResponse.json(contact, { status: 201 });
}
