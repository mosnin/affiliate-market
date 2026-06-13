'use client';

import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Star rating — one component, two modes.
 *
 * Read-only (default): renders `value` out of 5 with partial fill for the
 * fractional star, so "4.7" reads honestly. Interactive (`onChange` set): a
 * keyboard- and pointer-accessible 1–5 picker for the review form.
 *
 * Stars are mint (`text-brand`) — the system's positive/earned color — on a
 * muted track. No second accent; trust shouldn't shout.
 */
export function StarRating({
  value,
  onChange,
  size = 16,
  className,
  ariaLabel,
}: {
  value: number;
  onChange?: (next: number) => void;
  size?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const interactive = typeof onChange === 'function';
  const clamped = Math.max(0, Math.min(5, value));

  if (interactive) {
    return (
      <div
        role="radiogroup"
        aria-label={ariaLabel ?? 'Rating'}
        className={cn('inline-flex items-center gap-1', className)}
      >
        {[1, 2, 3, 4, 5].map((n) => {
          const active = n <= Math.round(clamped);
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={n === Math.round(clamped)}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              onClick={() => onChange(n)}
              className="rounded-md p-0.5 transition-transform duration-150 hover:scale-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            >
              <Star
                size={size}
                className={active ? 'fill-brand text-brand' : 'text-muted-foreground/40'}
                aria-hidden
              />
            </button>
          );
        })}
      </div>
    );
  }

  // Read-only: full + fractional + empty, with a clipped overlay for the
  // partial star so a 4.7 doesn't round up to a lie.
  return (
    <div
      className={cn('inline-flex items-center gap-0.5', className)}
      role="img"
      aria-label={ariaLabel ?? `${clamped} out of 5`}
    >
      {[0, 1, 2, 3, 4].map((i) => {
        const fill = Math.max(0, Math.min(1, clamped - i));
        return (
          <span key={i} className="relative inline-flex" style={{ width: size, height: size }}>
            <Star size={size} className="absolute inset-0 text-muted-foreground/30" aria-hidden />
            {fill > 0 && (
              <span
                className="absolute inset-0 overflow-hidden"
                style={{ width: `${fill * 100}%` }}
              >
                <Star size={size} className="fill-brand text-brand" aria-hidden />
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
