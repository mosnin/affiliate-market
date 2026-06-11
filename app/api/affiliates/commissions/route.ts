import { NextRequest, NextResponse } from 'next/server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import { listCommissions } from '@/lib/affiliates/commissions';

export async function GET(req: NextRequest) {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const status = req.nextUrl.searchParams.get('status') ?? undefined;
  const commissions = await listCommissions(result.space.id, status ? { status } : undefined);
  return NextResponse.json({ commissions });
}
