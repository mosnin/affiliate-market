'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PRIMARY_PILL } from '@/lib/typography';

const INPUT =
  'w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background';

const STATUS_COPY: Record<'requested' | 'approved' | 'declined', string> = {
  requested: 'Refund requested — the seller is reviewing it.',
  approved: 'Refund approved.',
  declined: 'Refund declined by the seller.',
};

/**
 * Buyer-side refund ask. A quiet disclosure on the order receipt: a single
 * "Request a refund" link reveals an optional reason and a submit. On success it
 * collapses to a calm confirmation. If a request already exists we never show
 * the form — just its current status, stated plainly.
 *
 * No money moves from here. This is the signal; the seller settles the refund.
 */
export function RefundRequestForm({
  orderId,
  existingStatus,
}: {
  orderId: string;
  existingStatus?: 'requested' | 'approved' | 'declined' | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // A request already exists — read-only status, no form.
  if (existingStatus) {
    return (
      <p className="text-sm text-muted-foreground">{STATUS_COPY[existingStatus]}</p>
    );
  }

  if (done) {
    return (
      <div className="flex items-center gap-2 text-sm text-positive">
        <Check size={15} aria-hidden />
        Refund requested — the seller will review it.
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <RotateCcw size={13} aria-hidden />
        Request a refund
      </button>
    );
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/buyer/refund-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, reason: reason.trim() || undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Could not request a refund. Try again.');
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={1000}
        rows={3}
        placeholder="Tell the seller what went wrong (optional)"
        className={cn(INPUT, 'resize-y')}
        aria-label="Reason for refund"
      />

      {error && <p className="text-sm text-negative">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className={cn(PRIMARY_PILL, 'disabled:opacity-60')}
        >
          {submitting ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null}
          Request refund
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={submitting}
          className="text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
