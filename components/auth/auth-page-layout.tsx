'use client';

/**
 * AuthPageLayout — Sequence fintech restyle.
 *
 * Split screen: deep-teal hero panel left (desktop), white auth card right on
 * the cool off-white canvas. The Clerk components, redirect wiring, role
 * switcher, and ToS copy are unchanged — only the chrome around them changes.
 *
 * Left panel: bg-hero, Cola wordmark top-left, a short value-prop line in
 * white/70, and one big stat-style focal line in white. On mobile the panel
 * collapses; the wordmark moves above the card.
 *
 * Right panel: off-white canvas (bg-background), centered white rounded-2xl
 * card with hairline border wrapping the form content.
 */

import React from 'react';
import { motion } from 'framer-motion';
import { BrandLogo } from '@/components/brand-logo';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, Check, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BODY_MUTED, CAPTION, CARD, H1, H2, SECTION_LABEL } from '@/lib/typography';
import { PAGE_VARIANTS } from '@/lib/motion';

export interface AuthPageLayoutProps {
  children: React.ReactNode;
  heading: string;
  subheading?: string;
  variant?: 'seller' | 'manager';
}

export function AuthPageLayout({ children, heading, subheading, variant: _variant }: AuthPageLayoutProps) {
  const pathname = usePathname();

  const isManagerLogin = pathname.startsWith('/login/manager');
  const isSellerLogin = pathname.startsWith('/login/seller');
  const showRoleSwitcher = isManagerLogin || isSellerLogin;

  return (
    <main className="relative grid min-h-screen bg-background lg:grid-cols-[1fr_1fr]">
      {/* ── Left: deep-teal hero panel (desktop) ── */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-hero p-12 lg:flex">
        {/* Subtle radial tint — depth without a shadow */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_80%,rgba(52,199,127,0.12),transparent_60%)]" />

        {/* Wordmark */}
        <Link href="/" className="relative z-10 flex items-center gap-2" aria-label="Cola home">
          <BrandLogo className="h-7 brightness-0 invert" alt="Cola" />
        </Link>

        {/* Value prop copy */}
        <div className="relative z-10 space-y-6">
          <p className={cn(SECTION_LABEL, 'text-white/60 tracking-[0.2em]')}>
            The agentic OS for real estate
          </p>
          <h2 className={cn(H2, 'text-[28px] leading-snug text-white font-semibold max-w-xs')}>
            Your pipeline, always moving.
          </h2>
          {/* Three proof points */}
          <ul className="space-y-2.5">
            {[
              'Drafts first-touch messages in seconds',
              'Scores and triages every new lead',
              'Works while you sleep',
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5">
                <Check size={14} className="mt-0.5 shrink-0 text-brand" />
                <span className="text-sm text-white/75">{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ── Right: off-white canvas + centered auth card ── */}
      <div className="flex min-h-screen flex-col items-center justify-between bg-background px-6 py-8 sm:px-10 sm:py-10">
        {/* Mobile wordmark */}
        <div className="w-full shrink-0 lg:hidden">
          <BrandLogo className="h-6 sm:h-7" alt="Cola" />
        </div>

        {/* Auth card */}
        <div className="w-full flex flex-1 items-center justify-center py-6 sm:py-8 lg:py-0">
          <motion.div
            variants={PAGE_VARIANTS}
            initial="initial"
            animate="enter"
            className={cn(CARD, 'w-full max-w-[400px] px-6 py-8 sm:px-8 space-y-6')}
          >
            {/* Role switcher — selectable card recipe: rounded-xl, border, selected = border-primary bg-brand-subtle/50 */}
            {showRoleSwitcher && (
              <div role="tablist" aria-label="Account type" className="flex gap-2">
                <Link
                  href="/login/seller"
                  role="tab"
                  aria-selected={isSellerLogin}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-all duration-150',
                    isSellerLogin
                      ? 'border-primary bg-brand-subtle/50 text-primary'
                      : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
                  )}
                >
                  <User size={14} className="shrink-0" />
                  Seller
                </Link>
                <Link
                  href="/login/manager"
                  role="tab"
                  aria-selected={isManagerLogin}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-all duration-150',
                    isManagerLogin
                      ? 'border-primary bg-brand-subtle/50 text-primary'
                      : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
                  )}
                >
                  <Building2 size={14} className="shrink-0" />
                  Manager
                </Link>
              </div>
            )}

            {/* Heading */}
            {heading && (
              <div className="space-y-1">
                <h1 className={H1}>{heading}</h1>
                {subheading && <p className={BODY_MUTED}>{subheading}</p>}
              </div>
            )}

            <div className="w-full">{children}</div>
          </motion.div>
        </div>

        {/* ToS / Privacy */}
        <p className={cn(CAPTION, 'w-full max-w-[400px] shrink-0 pt-2 text-center leading-relaxed')}>
          By continuing, you agree to our{' '}
          <Link href="/legal/terms" className="underline underline-offset-4 transition-colors hover:text-foreground">
            Terms of Service
          </Link>{' '}
          and{' '}
          <Link href="/legal/privacy" className="underline underline-offset-4 transition-colors hover:text-foreground">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
