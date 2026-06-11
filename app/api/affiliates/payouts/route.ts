import { NextResponse } from 'next/server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import { listPayouts } from '@/lib/affiliates/payouts';

export async function GET() {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const payouts = await listPayouts(result.space.id);
  return NextResponse.json({ payouts });
}
