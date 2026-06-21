import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

export type CommissionStatus = 'pending' | 'approved' | 'paid' | 'rejected';

export interface CommissionPlan {
  commissionType: 'percent' | 'flat';
  commissionValue: number;
}

/**
 * The effective commission plan: a product's override wins over the program
 * default when both override fields are set; otherwise the program applies.
 * One place so every caller (conversion, recurring, explore estimate) agrees.
 */
export function resolveCommissionPlan(
  program: { commissionType: 'percent' | 'flat'; commissionValue: number },
  product?: { commissionType?: string | null; commissionValue?: number | null } | null,
): CommissionPlan {
  if (
    product &&
    (product.commissionType === 'percent' || product.commissionType === 'flat') &&
    product.commissionValue != null &&
    Number(product.commissionValue) > 0
  ) {
    return { commissionType: product.commissionType, commissionValue: Number(product.commissionValue) };
  }
  return { commissionType: program.commissionType, commissionValue: program.commissionValue };
}

export interface CommissionRow {
  id: string;
  partnerId: string;
  partnerName: string;
  partnerEmail: string;
  referralId: string | null;
  orderId: string | null;
  amountCents: number;
  currency: string;
  status: CommissionStatus;
  level: number;
  createdAt: string;
  approvedAt: string | null;
}

/**
 * Pure commission math.
 * - percent: commissionValue is a 0–100 percentage of the order, rounded
 *   half-up to integer cents.
 * - flat: commissionValue IS the commission in cents, regardless of order amount.
 * Invalid input (NaN/negative) clamps to 0 — a wrong plan must never produce
 * a negative ledger entry.
 */
export function calculateCommissionCents(
  plan: CommissionPlan,
  orderAmountCents: number,
): number {
  const value = Number(plan.commissionValue);
  if (!Number.isFinite(value) || value <= 0) return 0;

  if (plan.commissionType === 'flat') {
    return Math.max(0, Math.round(value));
  }

  const amount = Number(orderAmountCents);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.max(0, Math.floor((amount * value) / 100 + 0.5));
}

export async function approveCommission(commissionId: string): Promise<boolean> {
  const { error } = await supabase
    .from('AffiliateCommission')
    .update({ status: 'approved', approvedAt: new Date().toISOString() })
    .eq('id', commissionId)
    .eq('status', 'pending');
  if (error) logger.warn('[affiliates] approveCommission failed', { error: error.message });
  return !error;
}

export async function rejectCommission(commissionId: string): Promise<boolean> {
  const { error } = await supabase
    .from('AffiliateCommission')
    .update({ status: 'rejected' })
    .eq('id', commissionId)
    .in('status', ['pending', 'approved']);
  if (error) logger.warn('[affiliates] rejectCommission failed', { error: error.message });
  return !error;
}

export async function listCommissions(
  spaceId: string,
  opts?: { status?: string },
): Promise<CommissionRow[]> {
  let query = supabase
    .from('AffiliateCommission')
    .select('id, partnerId, referralId, orderId, amountCents, currency, status, level, createdAt, approvedAt')
    .eq('spaceId', spaceId)
    .order('createdAt', { ascending: false })
    .limit(200);
  if (opts?.status) query = query.eq('status', opts.status);

  const { data: rows } = await query;
  if (!rows || rows.length === 0) return [];

  const partnerIds = [...new Set(rows.map((r) => r.partnerId))];
  const { data: partners } = await supabase
    .from('AffiliatePartner')
    .select('id, name, email')
    .in('id', partnerIds);
  const byId = new Map((partners ?? []).map((p) => [p.id, p]));

  return rows.map((r) => ({
    id: r.id,
    partnerId: r.partnerId,
    partnerName: byId.get(r.partnerId)?.name ?? 'Unknown',
    partnerEmail: byId.get(r.partnerId)?.email ?? '',
    referralId: r.referralId ?? null,
    orderId: r.orderId ?? null,
    amountCents: r.amountCents ?? 0,
    currency: r.currency ?? 'usd',
    status: r.status as CommissionStatus,
    level: r.level ?? 1,
    createdAt: r.createdAt,
    approvedAt: r.approvedAt ?? null,
  }));
}

/** Recent commissions for one partner (affiliate-facing dashboard). */
export async function listCommissionsForPartner(
  partnerId: string,
  limit = 50,
): Promise<Array<Pick<CommissionRow, 'id' | 'orderId' | 'amountCents' | 'currency' | 'status' | 'level' | 'createdAt'> & { netCents: number }>> {
  const { data } = await supabase
    .from('AffiliateCommission')
    .select('id, orderId, amountCents, netCents, currency, status, level, createdAt')
    .eq('partnerId', partnerId)
    .order('createdAt', { ascending: false })
    .limit(limit);
  return (data ?? []).map((r) => ({
    ...r,
    level: r.level ?? 1,
    netCents: r.netCents ?? r.amountCents ?? 0,
  })) as Array<Pick<CommissionRow, 'id' | 'orderId' | 'amountCents' | 'currency' | 'status' | 'level' | 'createdAt'> & { netCents: number }>;
}
