'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PRIMARY_PILL, GHOST_PILL } from '@/lib/typography';

type LinkState = 'idle' | 'loading' | 'copied' | 'pending';

/**
 * The explore page's one verb: turn a product into YOUR link. Joins the
 * seller's program on first use (pending state when the seller reviews
 * applications manually) and copies the referral URL to the clipboard.
 */
export function GetLinkButton({ productId }: { productId: string }) {
  const [state, setState] = useState<LinkState>('idle');

  async function getLink() {
    setState('loading');
    try {
      const res = await fetch('/api/affiliates/explore/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        toast.error('Sign in to get your link.');
        setState('idle');
        return;
      }
      if (data.pending) {
        toast.success('Application sent. The seller will review it shortly.');
        setState('pending');
        return;
      }
      if (!res.ok || !data.url) {
        toast.error(data.error || "Couldn't create your link. Try again.");
        setState('idle');
        return;
      }

      await navigator.clipboard.writeText(data.url).catch(() => {});
      toast.success('Link copied. Share it anywhere.');
      setState('copied');
    } catch {
      toast.error('Something went wrong. Try again.');
      setState('idle');
    }
  }

  if (state === 'pending') {
    return (
      <span className={cn(GHOST_PILL, 'pointer-events-none text-xs')}>Application pending</span>
    );
  }

  return (
    <button
      onClick={getLink}
      disabled={state === 'loading'}
      className={cn(PRIMARY_PILL, 'text-xs gap-1.5 disabled:opacity-60')}
    >
      {state === 'copied' ? (
        <>
          <Check size={13} aria-hidden /> Copied
        </>
      ) : (
        <>
          <Link2 size={13} aria-hidden /> {state === 'loading' ? 'Creating…' : 'Get my link'}
        </>
      )}
    </button>
  );
}
