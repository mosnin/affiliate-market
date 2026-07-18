import { BadgeCheck } from 'lucide-react';
import { StarRating } from './star-rating';
import type { PublicReview } from '@/lib/marketplace/reviews';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** The mint "Verified" trust chip — a platform vouch, not a seller claim. */
export function VerifiedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-lg bg-brand-subtle px-2 py-0.5 text-[11px] font-medium text-primary">
      <BadgeCheck size={13} aria-hidden />
      Verified
    </span>
  );
}

/**
 * Product reviews block for the detail page: the average star line + count, a
 * verified badge when the listing is vetted, and the buyer reviews themselves.
 * Read-only — leaving a review happens from the buyer dashboard, where we know
 * the buyer purchased.
 */
export function ReviewsSection({
  avgRating,
  reviewCount,
  verified,
  reviews,
}: {
  avgRating: number | null;
  reviewCount: number;
  verified: boolean;
  reviews: PublicReview[];
}) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Reviews
        </h2>
        {verified && <VerifiedBadge />}
      </div>

      {/* Average line */}
      {avgRating != null ? (
        <div className="flex items-center gap-3">
          <StarRating value={avgRating} size={18} />
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {avgRating.toFixed(1)}
          </span>
          <span className="text-xs text-muted-foreground">
            {reviewCount} review{reviewCount === 1 ? '' : 's'}
          </span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No reviews yet. Buyers can review this after purchase.
        </p>
      )}

      {/* List */}
      {reviews.length > 0 && (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-card">
          {reviews.map((r) => (
            <li key={r.id} className="space-y-1.5 px-4 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <StarRating value={r.rating} size={14} />
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {formatDate(r.createdAt)}
                </span>
              </div>
              {r.title && <p className="text-sm font-medium text-foreground">{r.title}</p>}
              {r.body && <p className="text-sm leading-relaxed text-foreground">{r.body}</p>}
              <p className="text-[11px] text-muted-foreground">{r.author}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
