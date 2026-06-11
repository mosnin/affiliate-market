'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { GHOST_PILL } from '@/lib/typography';

interface CommissionActionsProps {
  commissionId: string;
}

export function CommissionActions({ commissionId }: CommissionActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null);

  async function act(action: 'approve' | 'reject') {
    setLoading(action);
    try {
      const res = await fetch(`/api/affiliates/commissions/${commissionId}/${action}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error ?? `Failed to ${action} commission.`);
        return;
      }
      toast.success(action === 'approve' ? 'Commission approved.' : 'Commission rejected.');
      router.refresh();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => act('approve')}
        disabled={loading !== null}
        className={cn(GHOST_PILL, 'h-7 px-2.5 text-xs disabled:opacity-50')}
      >
        {loading === 'approve' ? 'approving…' : 'approve'}
      </button>
      <button
        onClick={() => act('reject')}
        disabled={loading !== null}
        className={cn(
          'inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-xs font-medium',
          'text-muted-foreground hover:text-red-600 hover:bg-red-50',
          'transition-colors duration-150 disabled:opacity-50',
        )}
      >
        {loading === 'reject' ? 'rejecting…' : 'reject'}
      </button>
    </div>
  );
}
