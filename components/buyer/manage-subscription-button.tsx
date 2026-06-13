'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Settings2 } from 'lucide-react';

/**
 * Opens the Stripe billing portal for the signed-in buyer (manage card,
 * invoices, cancel). Only rendered when the buyer has a subscription with a
 * Stripe customer.
 */
export function ManageSubscriptionButton() {
  const [loading, setLoading] = useState(false);

  async function open() {
    setLoading(true);
    try {
      const res = await fetch('/api/buyer/billing-portal', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        toast.error(data.error || 'Could not open billing.');
        return;
      }
      window.location.href = data.url;
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={open}
      disabled={loading}
      className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 h-9 text-sm font-medium text-foreground hover:bg-muted/60 transition-colors disabled:opacity-60"
    >
      <Settings2 size={14} aria-hidden />
      {loading ? 'Opening…' : 'Manage subscription'}
    </button>
  );
}
