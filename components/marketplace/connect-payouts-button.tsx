'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { PRIMARY_PILL } from '@/lib/typography';

/** Starts Stripe Connect onboarding so marketplace proceeds auto-transfer. */
export function ConnectPayoutsButton() {
  const [loading, setLoading] = useState(false);

  async function connect() {
    setLoading(true);
    try {
      const res = await fetch('/api/marketplace/connect', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        toast.error(data.error || "Couldn't start Stripe onboarding. Try again.");
        return;
      }
      window.location.href = data.url;
    } finally {
      setLoading(false);
    }
  }

  return (
    <button onClick={connect} disabled={loading} className={cn(PRIMARY_PILL, 'disabled:opacity-60')}>
      {loading ? 'Opening Stripe…' : 'Connect payouts'}
    </button>
  );
}
