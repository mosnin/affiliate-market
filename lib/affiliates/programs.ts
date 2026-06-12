import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

export interface AffiliateProgramRow {
  id: string;
  spaceId: string;
  name: string;
  commissionType: 'percent' | 'flat';
  commissionValue: number;
  recurring: boolean;
  recurringMonths: number | null;
  cookieWindowDays: number;
  autoApproveAffiliates: boolean;
  autoApproveCommissions: boolean;
  createdAt: string;
}

/**
 * Every Space gets one program, created lazily on first touch.
 * Default: 20% one-time commission, 30-day attribution window, manual approvals.
 */
export async function getOrCreateDefaultProgram(spaceId: string): Promise<AffiliateProgramRow> {
  const { data: existing } = await supabase
    .from('AffiliateProgram')
    .select('*')
    .eq('spaceId', spaceId)
    .order('createdAt', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) return existing as AffiliateProgramRow;

  const { data: created, error } = await supabase
    .from('AffiliateProgram')
    .insert({ spaceId })
    .select('*')
    .single();

  if (error || !created) {
    // Lost a create race? The select-again covers it.
    const { data: retry } = await supabase
      .from('AffiliateProgram')
      .select('*')
      .eq('spaceId', spaceId)
      .order('createdAt', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (retry) return retry as AffiliateProgramRow;
    logger.error('[affiliates] failed to create default program', { spaceId, error: error?.message });
    throw new Error('Failed to create affiliate program');
  }
  return created as AffiliateProgramRow;
}

export interface ProgramPatch {
  name?: string;
  commissionType?: 'percent' | 'flat';
  commissionValue?: number;
  cookieWindowDays?: number;
  autoApproveAffiliates?: boolean;
  autoApproveCommissions?: boolean;
  /** Pay creators on subscription renewals too. */
  recurring?: boolean;
  /** Cap on commissioned periods (1 = first month only); null/0 = lifetime. */
  recurringMonths?: number | null;
}

export async function updateProgram(
  spaceId: string,
  patch: ProgramPatch,
): Promise<AffiliateProgramRow | null> {
  const program = await getOrCreateDefaultProgram(spaceId);

  const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.commissionType !== undefined) update.commissionType = patch.commissionType;
  if (patch.commissionValue !== undefined) update.commissionValue = Math.max(0, patch.commissionValue);
  if (patch.cookieWindowDays !== undefined) {
    update.cookieWindowDays = Math.min(365, Math.max(1, Math.round(patch.cookieWindowDays)));
  }
  if (patch.autoApproveAffiliates !== undefined) update.autoApproveAffiliates = patch.autoApproveAffiliates;
  if (patch.autoApproveCommissions !== undefined) update.autoApproveCommissions = patch.autoApproveCommissions;
  if (patch.recurring !== undefined) update.recurring = patch.recurring;
  if (patch.recurringMonths !== undefined) {
    update.recurringMonths =
      patch.recurringMonths == null || patch.recurringMonths <= 0
        ? null
        : Math.min(120, Math.round(patch.recurringMonths));
  }

  const { data, error } = await supabase
    .from('AffiliateProgram')
    .update(update)
    .eq('id', program.id)
    .select('*')
    .single();

  if (error) {
    logger.warn('[affiliates] updateProgram failed', { spaceId, error: error.message });
    return null;
  }
  return data as AffiliateProgramRow;
}
