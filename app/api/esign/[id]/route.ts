/**
 * GET /api/esign/[id]?slug=<slug> — refresh + return one SignatureRequest's
 * status from DocuSign (via the seller's connected Composio account).
 *
 * Auth: requireSpaceOwner(slug). The request must belong to the caller's
 * space — defence-in-depth on top of the owner check.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSpaceOwner } from '@/lib/api-auth';
import { convex, api } from '@/lib/convex-server';
import { refreshEnvelopeStatus } from '@/lib/esign';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 });

  const auth = await requireSpaceOwner(slug);
  if (auth instanceof NextResponse) return auth;
  const { userId, space } = auth;

  // Scope the request to this space before any DocuSign work.
  const row = await convex().query(api.portal.signatures.getByIdForSpace, {
    id,
    spaceId: space.id,
  });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const result = await refreshEnvelopeStatus({ userId, signatureRequestId: id });

  if (result.ok) {
    return NextResponse.json({ request: result.signatureRequest });
  }
  if (result.reason === 'not_found') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (result.reason === 'not_connected') {
    return NextResponse.json(
      { error: 'Connect DocuSign to check status.', code: 'not_connected' },
      { status: 409 },
    );
  }
  // no_envelope / refresh_failed — return the stored row's status unchanged so
  // the UI still renders a pill rather than erroring.
  const stored = await convex().query(api.portal.signatures.getByIdForSpace, {
    id,
    spaceId: space.id,
  });
  return NextResponse.json({ request: stored ?? null });
}
