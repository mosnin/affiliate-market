'use client';

import { useEffect, useState } from 'react';
import { Target, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ContactAgentContextProps {
  contactId: string;
}

interface AgentContext {
  goalType: string | null;
  lastAction: string | null;
}

const GOAL_LABELS: Record<string, string> = {
  follow_up_sequence: 'Follow-up',
  demo_booking: 'Demo booking',
  offer_progress: 'Offer',
  deal_close: 'Closing',
  reengagement: 'Re-engage',
  custom: 'Goal',
};

export function ContactAgentContext({ contactId }: ContactAgentContextProps) {
  const [ctx, setCtx] = useState<AgentContext | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/agent/contact-context/${contactId}`, { signal: controller.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setCtx(data); })
      .catch(() => {});
    return () => controller.abort();
  }, [contactId]);

  if (!ctx?.goalType && !ctx?.lastAction) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {ctx.goalType && (
        <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-primary dark:text-primary bg-brand-subtle dark:bg-brand-subtle border border-primary/20 dark:border-primary/40 rounded-full px-1.5 py-0.5">
          <Target size={8} />
          {GOAL_LABELS[ctx.goalType] ?? ctx.goalType}
        </span>
      )}
      {ctx.lastAction && (
        <span className="text-[10px] text-muted-foreground truncate max-w-[120px] sm:max-w-[180px]">
          {ctx.lastAction}
        </span>
      )}
    </div>
  );
}
