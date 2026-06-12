'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { PRIMARY_PILL } from '@/lib/typography';

/** Invoice my saved payment method for off-platform commissions owed. */
export function SettleBridgeButton() {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function settle() {
    setLoading(true);
    try {
      const res = await fetch('/api/affiliates/settlement', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.settled) {
        toast.error(data.reason || "Couldn't settle right now. The balance stays on your ledger.");
        return;
      }
      toast.success(
        `Settled ${(data.totalCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} — your creators can now be paid out.`,
      );
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button onClick={settle} disabled={loading} className={cn(PRIMARY_PILL, 'disabled:opacity-60')}>
      {loading ? 'Settling…' : 'Settle now'}
    </button>
  );
}
