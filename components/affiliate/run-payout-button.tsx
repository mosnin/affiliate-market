'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { PRIMARY_PILL } from '@/lib/typography';
import { formatCurrency } from '@/lib/formatting';

export function RunPayoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleRun() {
    setLoading(true);
    try {
      const res = await fetch('/api/affiliates/payouts/run', { method: 'POST' });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(data?.error ?? 'Failed to run payout batch.');
        return;
      }

      const { payouts, totalCents } = data as { payouts: unknown[]; totalCents: number };
      if (!payouts || payouts.length === 0) {
        toast.info('No approved balances to pay out.');
      } else {
        toast.success(
          `Payout batch complete. ${payouts.length} ${payouts.length === 1 ? 'partner' : 'partners'} paid — ${formatCurrency(totalCents / 100)} total.`,
        );
      }
      router.refresh();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleRun}
      disabled={loading}
      className={cn(PRIMARY_PILL, 'disabled:opacity-50')}
    >
      {loading ? 'running batch…' : 'run payout batch'}
    </button>
  );
}
