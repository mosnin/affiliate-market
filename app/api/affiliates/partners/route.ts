import { NextResponse } from 'next/server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import { listPartners } from '@/lib/affiliates/partners';

export async function GET() {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const partners = await listPartners(result.space.id);
  return NextResponse.json({ partners });
}
