import { NextResponse } from 'next/server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import { getProgramStats } from '@/lib/affiliates/stats';

export async function GET() {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const stats = await getProgramStats(result.space.id);
  return NextResponse.json({ stats });
}
