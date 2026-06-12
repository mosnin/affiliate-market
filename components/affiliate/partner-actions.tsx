'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { GHOST_PILL, PRIMARY_PILL } from '@/lib/typography';

interface PartnerActionsProps {
  partnerId: string;
  status: 'pending' | 'approved' | 'suspended';
}

export function PartnerActions({ partnerId, status }: PartnerActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState<'approve' | 'suspend' | null>(null);

  async function act(action: 'approve' | 'suspend') {
    setLoading(action);
    try {
      const res = await fetch(`/api/affiliates/partners/${partnerId}/${action}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error ?? `Failed to ${action} partner.`);
        return;
      }
      toast.success(action === 'approve' ? 'Partner approved.' : 'Partner suspended.');
      router.refresh();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex items-center gap-1">
      {status !== 'approved' && (
        <button
          onClick={() => act('approve')}
          disabled={loading !== null}
          className={cn(PRIMARY_PILL, 'h-8 px-3 text-xs disabled:opacity-50')}
        >
          {loading === 'approve' ? 'approving…' : 'approve'}
        </button>
      )}
      {status !== 'suspended' && (
        <button
          onClick={() => act('suspend')}
          disabled={loading !== null}
          className={cn(GHOST_PILL, 'h-8 px-3 text-xs disabled:opacity-50')}
        >
          {loading === 'suspend' ? 'suspending…' : 'suspend'}
        </button>
      )}
    </div>
  );
}
