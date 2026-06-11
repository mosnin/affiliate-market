import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import { approveCommission } from '@/lib/affiliates/commissions';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const { id } = await params;
  const { data: commission } = await supabase
    .from('AffiliateCommission')
    .select('id, spaceId')
    .eq('id', id)
    .maybeSingle();
  if (!commission || commission.spaceId !== result.space.id) {
    return NextResponse.json({ error: 'Commission not found' }, { status: 404 });
  }

  const ok = await approveCommission(id);
  if (!ok) return NextResponse.json({ error: 'Approve failed' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
