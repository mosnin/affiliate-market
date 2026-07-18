import { NextRequest, NextResponse } from 'next/server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import { approvePartner, getPartnerById } from '@/lib/affiliates/partners';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const { id } = await params;
  const partner = await getPartnerById(id);
  if (!partner || partner.spaceId !== result.space.id) {
    return NextResponse.json({ error: 'Partner not found' }, { status: 404 });
  }

  const updated = await approvePartner(id);
  if (!updated) return NextResponse.json({ error: 'Approve failed' }, { status: 500 });
  return NextResponse.json({ partner: updated });
}
