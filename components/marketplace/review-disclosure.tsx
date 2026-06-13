'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';
import { LeaveReviewForm } from './leave-review-form';

/**
 * A quiet "Leave a review" link that reveals the inline review form in place.
 * Keeps the buyer on their dashboard — buying and reviewing are one breath
 * apart, so the form shouldn't be a page away.
 */
export function ReviewDisclosure({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <div className="mt-3">
        <LeaveReviewForm productId={productId} productName={productName} compact />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <Star size={13} aria-hidden />
      Leave a review
    </button>
  );
}
