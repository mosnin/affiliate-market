'use client';

import { AnimatePresence, motion } from 'motion/react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OnboardingBrandMark } from './onboarding-brand-mark';
import { CARD, GHOST_PILL } from '@/lib/typography';

interface OnboardingShellProps {
  /** Zero-based index of the active step. */
  stepIndex: number;
  /** Total step count across the current path. */
  totalSteps: number;
  /** Must change per step to trigger AnimatePresence exit/enter. */
  stepKey: string;
  /** The rendered step content. */
  children: React.ReactNode;
  /** Optional back handler - rendered as a subtle top-left affordance. */
  onBack?: () => void;
  /**
   * Hide the progress segments for "bookend" stages. Defaults to false.
   */
  hideProgress?: boolean;
}

/**
 * The shared onboarding surface — Sequence fintech restyle.
 *
 * Cool off-white canvas (bg-background), white rounded-2xl card per step,
 * step progress as a row of small segment chips (current = bg-brand text-brand-foreground,
 * done = bg-brand-subtle text-primary + Check icon, upcoming = bg-muted text-muted-foreground).
 */
export function OnboardingShell({ stepIndex, totalSteps, stepKey, children, onBack, hideProgress }: OnboardingShellProps) {
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Back button — top-left, ghost pill */}
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className={cn(GHOST_PILL, 'absolute left-5 top-5 z-20')}
        >
          ← Back
        </button>
      )}

      {/* Content */}
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 py-20">
        <OnboardingBrandMark />

        {/* Step progress row */}
        {totalSteps > 1 && !hideProgress && (
          <div className="mt-6 flex items-center gap-1.5" aria-hidden>
            {Array.from({ length: totalSteps }).map((_, i) => {
              const complete = i < stepIndex;
              const active = i === stepIndex;
              return (
                <motion.span
                  key={i}
                  className={cn(
                    'inline-flex h-6 items-center justify-center rounded-lg text-[10px] font-semibold transition-colors duration-200',
                    active
                      ? 'bg-brand text-brand-foreground px-2.5'
                      : complete
                        ? 'bg-brand-subtle text-primary px-2'
                        : 'bg-muted text-muted-foreground px-2',
                  )}
                  animate={{ minWidth: active ? 32 : 24 }}
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                >
                  {complete ? <Check size={10} strokeWidth={2.5} /> : i + 1}
                </motion.span>
              );
            })}
          </div>
        )}

        {/* Step card */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={stepKey}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className={cn(CARD, 'mt-6 w-full max-w-3xl px-6 py-8 sm:px-10')}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
