'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PRIMARY_PILL } from '@/lib/typography';
import { StarRating } from './star-rating';

const INPUT =
  'w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background';

/**
 * Buyer review form. Pick a star rating (required), add an optional headline
 * and a few words, submit. On success it collapses to a quiet confirmation —
 * a buyer reviews a product once, so there's nothing to re-submit.
 *
 * `compact` is the dashboard variant: tighter, no card chrome of its own.
 */
export function LeaveReviewForm({
  productId,
  productName,
  compact = false,
}: {
  productId: string;
  productName?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (rating < 1) {
      setError('Pick a star rating first.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, rating, title: title.trim(), body: body.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Could not save your review.');
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

  if (done) {
    return (
      <div className="flex items-center gap-2 text-sm text-positive">
        <Check size={15} aria-hidden />
        Thanks — your review is live.
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', !compact && 'rounded-2xl border border-border bg-card p-4')}>
      <div className="flex flex-wrap items-center gap-3">
        <StarRating value={rating} onChange={setRating} size={22} ariaLabel="Your rating" />
        {productName && !compact && (
          <span className="text-sm text-muted-foreground">{productName}</span>
        )}
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={120}
        placeholder="Sum it up (optional)"
        className={INPUT}
        aria-label="Review title"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={4000}
        rows={compact ? 2 : 3}
        placeholder="What should other buyers know? (optional)"
        className={cn(INPUT, 'resize-y')}
        aria-label="Review body"
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
          Post review
        </button>
      </div>
    </div>
  );
}
