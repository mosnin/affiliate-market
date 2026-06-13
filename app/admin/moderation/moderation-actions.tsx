'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GHOST_PILL } from '@/lib/typography';

/**
 * Hide / Unhide a review. Optimistic-free: it calls the admin route, then
 * refreshes the server data so the row's status chip is always the truth.
 */
export function ReviewModerationButton({
  reviewId,
  status,
}: {
  reviewId: string;
  status: 'published' | 'hidden';
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const next = status === 'published' ? 'hidden' : 'published';

  async function go() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/reviews/${reviewId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      className={cn(GHOST_PILL, 'h-8 px-3 text-xs disabled:opacity-60')}
    >
      {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
      {status === 'published' ? 'Hide' : 'Unhide'}
    </button>
  );
}

/**
 * Verify / Unverify a listing. Verify reads as the primary, mint action (a
 * vouch); unverify is the quiet ghost that walks it back.
 */
export function VerifyProductButton({
  productId,
  verified,
}: {
  productId: string;
  verified: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/products/${productId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verified: !verified }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      className={cn(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition-all duration-150 active:scale-[0.98] disabled:opacity-60',
        verified
          ? 'border border-border bg-card text-foreground hover:bg-muted/60'
          : 'bg-brand text-brand-foreground hover:bg-brand/85',
      )}
    >
      {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
      {verified ? 'Unverify' : 'Verify'}
    </button>
  );
}
