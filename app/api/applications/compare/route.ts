import { NextRequest, NextResponse } from 'next/server';
import { convex, api } from '@/lib/convex-server';
import { requireSpaceOwner } from '@/lib/api-auth';

/**
 * GET — Compare multiple applicants side by side.
 * Query params: slug, ids (comma-separated contact IDs)
 */
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug');
  const idsParam = req.nextUrl.searchParams.get('ids');

  if (!slug || !idsParam) {
    return NextResponse.json({ error: 'slug and ids required' }, { status: 400 });
  }

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;

  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
  if (ids.length < 2) {
    return NextResponse.json({ error: 'At least 2 IDs required' }, { status: 400 });
  }

  const rows = await convex().query(api.contacts.contacts.getManyByIds, {
    ids,
    spaceId: auth.space.id,
  });

  if (!rows?.length) {
    return NextResponse.json({ error: 'No contacts found' }, { status: 404 });
  }

  // Project to the same column set the PostgREST .select() returned, so the
  // compare client sees an identical shape.
  const contacts = rows.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    budget: c.budget,
    leadType: c.leadType,
    leadScore: c.leadScore,
    scoreLabel: c.scoreLabel,
    scoreSummary: c.scoreSummary,
    applicationData: c.applicationData,
    applicationStatus: c.applicationStatus,
    createdAt: c.createdAt,
  }));

  return NextResponse.json(contacts);
}
