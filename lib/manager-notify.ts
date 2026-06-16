/**
 * Helper to create manager notifications.
 * Non-blocking — failures are logged but never throw.
 */

import { convex, api } from '@/lib/convex-server';
import { logger } from '@/lib/logger';

export type ManagerNotificationType =
  | 'member_joined'
  | 'member_removed'
  | 'deal_won'
  | 'deal_created'
  | 'lead_hot'
  | 'review_requested';

export interface NotifyManagerParams {
  companyId: string;
  type: ManagerNotificationType;
  title: string;
  body?: string;
  metadata?: Record<string, unknown>;
}

export async function notifyManager(params: NotifyManagerParams): Promise<void> {
  const { companyId, type, title, body, metadata } = params;

  try {
    await convex().mutation(api.notifications.manager.create, {
      companyId,
      type,
      title,
      ...(body !== undefined ? { body } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  } catch (err) {
    logger.error('[manager-notify] failed to create notification', { type, companyId }, err);
  }
}
