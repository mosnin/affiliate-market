'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { PRIMARY_PILL, GHOST_PILL } from '@/lib/typography';

/**
 * Seller's two-button verdict on an open refund request, shown inline on the
 * order row. Approve fires the actual refund (server-side, via markOrderRefunded);
 * decline just records the decision. Both refresh the page so the row's
 * "Refund requested" chip and these buttons clear once resolved.
 */
export function RefundRequestActions({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<'approve' | 'decline' | null>(null);

  async function resolve(action: 'approve' | 'decline') {
    setPending(action);
    try {
      const res = await fetch('/api/s/refund-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, action }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Could not update the request.');
        return;
      }
      toast.success(action === 'approve' ? 'Refund issued.' : 'Refund declined.');
      router.refresh();
    } catch {
      toast.error('Something went wrong. Try again.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => resolve('approve')}
        disabled={pending !== null}
        className={cn(PRIMARY_PILL, 'h-8 px-3 text-xs disabled:opacity-60')}
      >
        {pending === 'approve' ? 'Refunding…' : 'Approve'}
      </button>
      <button
        type="button"
        onClick={() => resolve('decline')}
        disabled={pending !== null}
        className={cn(GHOST_PILL, 'h-8 px-3 text-xs disabled:opacity-60')}
      >
        {pending === 'decline' ? 'Declining…' : 'Decline'}
      </button>
    </div>
  );
}
