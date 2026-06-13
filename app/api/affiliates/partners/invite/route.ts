import { NextRequest, NextResponse } from 'next/server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import { createPartner } from '@/lib/affiliates/partners';
import { getCreatorProfileByEmail } from '@/lib/affiliates/creators';

/** Seller invites a creator from the directory into their program. */
export async function POST(req: NextRequest) {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  let name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  }
  // Prefer the creator's own profile name when the caller didn't supply one.
  if (!name) {
    const profile = await getCreatorProfileByEmail(email);
    name = profile?.name ?? email.split('@')[0];
  }

  const invited = await createPartner({
    spaceId: result.space.id,
    name,
    email,
    invitedBySeller: true,
  });
  if (!invited) return NextResponse.json({ error: 'Could not send the invite.' }, { status: 500 });

  return NextResponse.json({ partner: { id: invited.partner.id, status: invited.partner.status } });
}
