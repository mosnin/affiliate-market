import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { createPartner } from '@/lib/affiliates/partners';
import { getLinkByCode } from '@/lib/affiliates/links';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * Public affiliate application. The target seller is resolved from
 * `spaceSlug`, from an existing referral `code` (join the program that code
 * belongs to), or — for the single-tenant common case — the first space.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const { allowed } = await checkRateLimit(`affiliate-join:${ip}`, 10, 600);
  if (!allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
  const spaceSlug = typeof body.spaceSlug === 'string' ? body.spaceSlug.trim().toLowerCase() : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';

  if (!name || !email || !email.includes('@')) {
    return NextResponse.json({ error: 'Name and a valid email are required.' }, { status: 400 });
  }

  // Resolve the seller space.
  let spaceId: string | null = null;
  if (spaceSlug) {
    const { data: space } = await supabase
      .from('Space')
      .select('id')
      .eq('slug', spaceSlug)
      .maybeSingle();
    spaceId = space?.id ?? null;
  }
  if (!spaceId && code) {
    const link = await getLinkByCode(code);
    if (link) {
      const { data: program } = await supabase
        .from('AffiliateProgram')
        .select('spaceId')
        .eq('id', link.programId)
        .maybeSingle();
      spaceId = program?.spaceId ?? null;
    }
    if (!spaceId) {
      // Allow pasting a space slug into the code field.
      const { data: space } = await supabase
        .from('Space')
        .select('id')
        .eq('slug', code.toLowerCase())
        .maybeSingle();
      spaceId = space?.id ?? null;
    }
  }
  if (!spaceId) {
    const { data: spaces } = await supabase
      .from('Space')
      .select('id')
      .order('createdAt', { ascending: true })
      .limit(2);
    if (spaces && spaces.length === 1) spaceId = spaces[0].id;
  }
  if (!spaceId) {
    return NextResponse.json(
      { error: 'Could not find that program. Ask the seller for their join code.' },
      { status: 404 },
    );
  }

  // Link the application to the signed-in user when there is one.
  let clerkUserId: string | null = null;
  try {
    const session = await auth();
    clerkUserId = session.userId ?? null;
  } catch {
    clerkUserId = null;
  }

  const result = await createPartner({ spaceId, name, email, clerkUserId });
  if (!result) {
    return NextResponse.json({ error: 'Could not submit your application.' }, { status: 500 });
  }

  logger.info('[affiliates] join application', {
    created: result.created,
    status: result.partner.status,
  });

  return NextResponse.json({
    status: result.partner.status,
    alreadyApplied: !result.created,
  });
}
