/**
 * Five named moments where brand orange earns its place. Each
 * primitive imports a context tag from `lib/colors.ts` so the
 * stray-orange lint rule (Phase 2) can verify the orange is
 * deliberate.
 *
 * Read STYLESHEET.md §Color §The brand orange rule before adding a
 * sixth — adding requires deleting one of the existing five.
 */

import { cn } from '@/lib/utils';
import { brandOrange } from '@/lib/colors';

/**
 * `ColaAuthoredDot` — a 4px orange dot rendered beside the
 * author's icon on rows where Cola was the actor.
 *
 * Used in: activity feed rows, conversation message metadata,
 * audit-log entries. ONLY on rows where `agentType === 'cola'`.
 *
 * The dot is non-decorative — its presence reads as "this row was
 * Cola's work, not the seller's." Pair with `aria-label` for
 * screen readers.
 */
export function ColaAuthoredDot({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="By Cola"
      className={brandOrange(
        'AGENT_BADGE',
        cn(
          'inline-block w-1 h-1 rounded-full',
          'bg-brand dark:bg-brand',
          className,
        ),
      )}
    />
  );
}

/**
 * `ColaWordmarkInline` — the literal word "Cola" rendered in
 * serif Times in `text-primary`, sized to flow inline with body
 * copy.
 *
 * Use it once per surface, at most. The whole point is scarcity:
 * when "Cola" reads as the punctuation of a sentence, the brand
 * becomes the voice of the product.
 *
 * Reach for this in:
 *   - The morning-story headline when introducing what Cola did
 *     overnight ("**Cola** drafted 3 messages while you slept.")
 *   - The empty-state line on /cola/today when no work happened
 *   - A post-action acknowledgment ("**Cola** sent it.") sparingly
 *
 * Do NOT reach for it in:
 *   - Anything multi-occurrence (a list, a table, repeated UI)
 *   - Body paragraphs where the brand is mentioned by name multiple
 *     times — pick one, leave the rest as plain text
 */
export function ColaWordmarkInline({ className }: { className?: string }) {
  return (
    <span
      className={brandOrange(
        'COLA_AVATAR',
        cn(
          'text-primary dark:text-primary',
          className,
        ),
      )}
      style={{ fontFamily: 'var(--font-title)' }}
    >
      Cola
    </span>
  );
}
