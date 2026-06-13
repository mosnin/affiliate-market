import { NextRequest, NextResponse } from 'next/server';
import { requireSellerSpace } from '@/lib/affiliates/api-helpers';
import { getOrCreateDefaultProgram, updateProgram } from '@/lib/affiliates/programs';

export async function GET() {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  const program = await getOrCreateDefaultProgram(result.space.id);
  return NextResponse.json({ program });
}

export async function PATCH(req: NextRequest) {
  const result = await requireSellerSpace();
  if (result instanceof NextResponse) return result;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const patch: Parameters<typeof updateProgram>[1] = {};
  if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 120);
  if (body.commissionType === 'percent' || body.commissionType === 'flat') {
    patch.commissionType = body.commissionType;
  }
  if (typeof body.commissionValue === 'number' && Number.isFinite(body.commissionValue)) {
    patch.commissionValue = body.commissionValue;
  }
  if (typeof body.cookieWindowDays === 'number' && Number.isFinite(body.cookieWindowDays)) {
    patch.cookieWindowDays = body.cookieWindowDays;
  }
  if (typeof body.autoApproveAffiliates === 'boolean') {
    patch.autoApproveAffiliates = body.autoApproveAffiliates;
  }
  if (typeof body.autoApproveCommissions === 'boolean') {
    patch.autoApproveCommissions = body.autoApproveCommissions;
  }
  if (typeof body.recurring === 'boolean') {
    patch.recurring = body.recurring;
  }
  if (typeof body.tier2Enabled === 'boolean') {
    patch.tier2Enabled = body.tier2Enabled;
  }
  if (typeof body.tier2Percent === 'number' && Number.isFinite(body.tier2Percent)) {
    patch.tier2Percent = body.tier2Percent;
  }
  if (body.recurringMonths === null) {
    patch.recurringMonths = null;
  } else if (typeof body.recurringMonths === 'number' && Number.isFinite(body.recurringMonths)) {
    patch.recurringMonths = body.recurringMonths;
  }

  const program = await updateProgram(result.space.id, patch);
  if (!program) return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  return NextResponse.json({ program });
}
