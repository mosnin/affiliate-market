/**
 * Support tickets (seller-facing) — GET / POST
 *
 *   GET  ?slug=<slug>  → { tickets: [...] }   the caller's own tickets, newest first
 *   POST { slug, category, subject, message }  → { ticket }   create a ticket
 *
 * Auth: requireSpaceOwner(slug) — the workspace owner (or a manager_owner/admin
 * managing that space). The submitter's email/name come from Clerk, not the
 * request body, so a caller can't spoof identity.
 */

import { NextRequest, NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import { requireSpaceOwner } from '@/lib/api-auth';
import { convex, api } from '@/lib/convex-server';
import { checkRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const CATEGORIES = ['bug', 'question', 'billing', 'feature', 'other'] as const;
type Category = (typeof CATEGORIES)[number];

const SUBJECT_MAX = 200;
const MESSAGE_MAX = 5000;

// ── GET — the caller's own tickets ──────────────────────────────────────────

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  let tickets;
  try {
    tickets = await convex().query(api.support.tickets.listByUser, { userId });
  } catch (err) {
    logger.error('[support] list failed', {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Could not load your tickets.' }, { status: 500 });
  }

  return NextResponse.json({ tickets });
}

// ── POST — create a ticket ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let payload: { slug?: string; category?: string; subject?: string; message?: string };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const slug = payload.slug?.trim();
  if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { userId, space } = auth;

  // Rate limit — a seller opening tickets in a tight loop is either a bug or
  // abuse. 10 per minute is generous for a human filling out a form.
  const { allowed } = await checkRateLimit(`support:create:${userId}`, 10, 60);
  if (!allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again shortly.' }, { status: 429 });
  }

  const subject = (payload.subject ?? '').trim();
  const message = (payload.message ?? '').trim();
  if (!subject) return NextResponse.json({ error: 'Add a subject.' }, { status: 400 });
  if (!message) return NextResponse.json({ error: 'Add a message.' }, { status: 400 });
  if (subject.length > SUBJECT_MAX) {
    return NextResponse.json({ error: `Subject must be ${SUBJECT_MAX} characters or fewer.` }, { status: 400 });
  }
  if (message.length > MESSAGE_MAX) {
    return NextResponse.json({ error: `Message must be ${MESSAGE_MAX} characters or fewer.` }, { status: 400 });
  }

  const rawCategory = (payload.category ?? 'other').trim();
  const category: Category = (CATEGORIES as readonly string[]).includes(rawCategory)
    ? (rawCategory as Category)
    : 'other';

  // Resolve the submitter's identity from Clerk — never trust the body for this.
  let email = '';
  let name: string | null = null;
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(userId);
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
    email = primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? '';
    name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || null;
  } catch (err) {
    logger.warn('[support] could not resolve clerk identity', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (!email) {
    return NextResponse.json(
      { error: 'Could not resolve your account email. Try again.' },
      { status: 500 },
    );
  }

  let ticket;
  try {
    ticket = await convex().mutation(api.support.tickets.create, {
      spaceId: space.id,
      userId,
      email,
      name,
      subject,
      message,
      category,
    });
  } catch (err) {
    logger.error('[support] create failed', {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Could not submit your request. Try again.' }, { status: 500 });
  }

  return NextResponse.json({ ticket });
}
